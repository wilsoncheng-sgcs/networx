import type { NetNode, TerminalLine } from '../../types'
import { type TermContext, type Lines, out, err, info, self } from '../context'
import { resolveTarget, isResolveError, isIp, routeTo } from '../resolve'
import { errnoText } from '../routing'
import { playUnreachable } from '../unreachable'
import { playLookup } from '../lookup'
import { isListening } from '../services'
import {
  type Step, type CertInfo, type CertProblem, type Leg,
  newConversation, tcpOpen, tcpRefused, tcpClose, tlsHandshake, tlsRejected, certificateFor, certProblem, formatCertDate,
  dnsConversation, runConversations, byteLength,
} from '../exchange'

// ── URLs ─────────────────────────────────────────────────────────────────────

export interface ParsedUrl {
  scheme: 'http' | 'https'
  host: string
  port: number
  path: string
  /** Normalised, with the scheme: what the browser's address bar shows. */
  href: string
}

/** `http://host[:port][/path]`, `https://…`, or a bare host (means http://). */
export function parseUrl(raw: string): ParsedUrl | null {
  const m = raw.trim().match(/^(?:(https?):\/\/)?([^/:?#\s]+)(?::(\d{1,5}))?([^\s]*)$/i)
  if (!m) return null
  const scheme = (m[1]?.toLowerCase() ?? 'http') as 'http' | 'https'
  const host = m[2]!.toLowerCase()
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80
  if (port < 1 || port > 65535) return null
  const path = m[4] && m[4].startsWith('/') ? m[4] : `/${m[4] ?? ''}`
  const defaultPort = scheme === 'https' ? 443 : 80
  const href = `${scheme}://${host}${port === defaultPort ? '' : `:${port}`}${path}`
  return { scheme, host, port, path, href }
}

// ── HTTP messages ────────────────────────────────────────────────────────────

export const CURL_USER_AGENT = 'curl/8.7.1'
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Networx Browser)'

export type HttpMethod = 'GET' | 'HEAD'

export function httpRequestHeaders(host: string, path: string, userAgent = CURL_USER_AGENT, method: HttpMethod = 'GET'): string[] {
  return [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    `User-Agent: ${userAgent}`,
    `Accept: ${userAgent === CURL_USER_AGENT ? '*/*' : 'text/html'}`,
  ]
}

/** Status line and headers. With `redirectTo`: 301 Moved Permanently and a Location header, no body. */
export function httpResponseHeaders(body: string, redirectTo?: string): string[] {
  if (redirectTo) {
    return ['HTTP/1.1 301 Moved Permanently', `Location: ${redirectTo}`, 'Content-Length: 0']
  }
  return [
    'HTTP/1.1 200 OK',
    'Content-Type: text/html; charset=utf-8',
    `Content-Length: ${byteLength(body)}`,
  ]
}

export interface HttpOptions {
  method?: HttpMethod
  /** The server redirects this request (HTTP → HTTPS). */
  redirectTo?: string
}

/**
 * One HTTP request and its response. With `tls`, the same bytes travel inside TLS (encrypted on the wire).
 * HEAD and 301 responses carry headers only.
 */
export function httpExchange(host: string, path: string, body: string, tls = false, userAgent = CURL_USER_AGENT, opts: HttpOptions = {}): Step[] {
  const { method = 'GET', redirectTo } = opts
  const request = httpRequestHeaders(host, path, userAgent, method).join('\n')
  const headers = httpResponseHeaders(body, redirectTo)
  const response = method === 'HEAD' || redirectTo ? headers.join('\n') : [...headers, '', body].join('\n')
  const status = headers[0]!.replace('HTTP/1.1 ', '')
  const short = redirectTo ? '301 Moved' : status
  if (tls) {
    return [
      { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: `🔒 ${method}`, info: 'Application Data', payload: request, encrypted: true },
      { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: `🔒 ${short}`.slice(0, 14), info: 'Application Data', payload: response, encrypted: true },
    ]
  }
  const responseInfo = redirectTo
    ? `HTTP/1.1 301 Moved Permanently  (Location: ${redirectTo})`
    : `HTTP/1.1 ${status}${method === 'HEAD' ? '' : '  (text/html)'}`
  return [
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'HTTP', label: `${method} ${path}`.slice(0, 14), info: `${method} ${path} HTTP/1.1`, payload: request },
    { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'HTTP', label: short, info: responseInfo, payload: response },
  ]
}

/** What a server sends back for a page. Internet hosts get a stand-in page. */
export function pageFor(server: NetNode, host: string, ip: string): string {
  if (server.data.deviceType === 'cloud') {
    return `<!DOCTYPE html>
<html>
<head><title>${host}</title></head>
<body style="font-family:sans-serif;padding:24px;color:#333">
<p style="color:#888;font-size:12px">Simulated internet page — Networx</p>
<h1>${host}</h1>
<p>This is a simulated response from the public internet.</p>
<p>The real <strong>${host}</strong> (${ip}) cannot be shown here.</p>
<p>To serve a custom page, add a <em>Web Server</em> node to your network with IP <code>${ip}</code>.</p>
</body>
</html>`
  }
  return (server.data.pageContent ?? '').trim() || '<html><body><h1>Empty Page</h1></body></html>'
}

// ── Fetching a URL (shared by curl and the browser) ─────────────────────────

export type WebFailure = 'bad-url' | 'nxdomain' | 'no-dns' | 'dns-failed' | 'no-route' | 'unreachable' | 'timeout' | 'refused' | 'cert'

export interface WebResult {
  ok: boolean
  url: ParsedUrl | null
  failure?: WebFailure
  ip?: string
  body?: string
  cert?: CertInfo
  /** Why the address couldn't be reached (subnet, gateway or private-address rules). */
  explain?: string
  /** The server answered 301: where it points (the browser follows it). */
  redirect?: string
  /** Set when the certificate failed the check (whether or not `insecure` let the request go on). */
  problem?: CertProblem
  lines: TerminalLine[]
  /** When the last packet arrives (ms): the browser shows the page then. */
  endMs: number
}

interface FetchOptions {
  verbose?: boolean
  /** curl -k: carry on when the certificate fails the check. */
  insecure?: boolean
  /** curl -I: send HEAD and print only the response headers. */
  head?: boolean
  userAgent?: string
  /** curl prints lines; the browser plays the same Conversations silently. */
  withLines?: boolean
}

export function fetchUrl(raw: string, ctx: TermContext, opts: FetchOptions = {}): WebResult {
  const { verbose = false, insecure = false, head = false, userAgent = CURL_USER_AGENT, withLines = true } = opts
  const url = parseUrl(raw)
  if (!url) return { ok: false, url: null, failure: 'bad-url', lines: [err(`curl: (3) URL rejected: Bad hostname`)], endMs: 0 }
  const { host, port, scheme, path } = url
  const tls = scheme === 'https'
  const v = (line: TerminalLine) => (verbose && withLines ? [line] : [])
  const L = (line: TerminalLine) => (withLines ? [line] : [])

  // 1. Name → address
  const r = resolveTarget(host, ctx)
  const legs: Leg[] = []
  const resolvedLines: Lines = isResolveError(r) ? [] : [
    ...(r.dnsServerIp ? v(info(`ⓘ DNS: asked ${r.dnsServerIp} on port 53 (UDP): ${host} → ${r.ip}`)) : []),
    ...(r.cached ? v(info(`ⓘ DNS: ${host} → ${r.ip} from this device's DNS cache (nothing sent)`)) : []),
    ...(isIp(host) ? [] : v(out(`* Host ${host}:${port} was resolved.`))),
    ...(isIp(host) ? [] : v(out(`* IPv4: ${r.ip}`))),
    ...v(out(`*   Trying ${r.ip}:${port}...`)),
  ]

  if (isResolveError(r)) {
    const failLines = r.error === 'no-route'
      ? L(err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: No route to host`))
      : [...L(err(`curl: (6) Could not resolve host: ${host}`)), ...(r.explain ? L(info(r.explain)) : [])]
    const run = playLookup(r, ctx, failLines)
    const failure: WebFailure = r.error === 'nxdomain' || r.error === 'no-dns' ? r.error : 'dns-failed'
    return { ok: false, url, failure, explain: r.explain, lines: run.lines, endMs: run.endMs }
  }

  const dnsLeg = dnsConversation(r, ctx, resolvedLines)
  if (dnsLeg) legs.push(dnsLeg)
  const immediate: Lines = dnsLeg ? [] : resolvedLines

  // 2. Is anything listening on that port?
  const server = r.node
  const route = routeTo(server, r.ip, ctx, { protocol: 'TCP', port })
  if (!server || !route.ok) {
    // Subnet, gateway or private-address rules stop it: show how far the SYN gets, then why
    const timeout = !route.ok && (route.failure === 'private' || route.failure === 'not-on-network' || route.failure === 'no-reply' || route.failure === 'blocked')
    const why = route.ok ? 'No route to host' : errnoText(route.failure)
    const failLines = [
      ...L(timeout
        ? err(`curl: (28) Failed to connect to ${host} port ${port} after 75000 ms: Timeout was reached`)
        : err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: ${why}`)),
      ...(!route.ok && route.explain ? L(info(route.explain)) : []),
    ]
    const dns = runConversations(legs, ctx)
    const played = route.ok
      ? { lines: failLines.map((l) => ({ ...l, delayMs: dns.endMs })), endMs: dns.endMs }
      : playUnreachable(route, { kind: 'tcp', port }, r.ip, ctx, failLines, dns.endMs)
    return {
      ok: false, url, failure: timeout ? 'timeout' : route.ok ? 'no-route' : 'unreachable', ip: r.ip,
      explain: route.ok ? undefined : route.explain,
      lines: [...immediate, ...dns.lines, ...played.lines], endMs: played.endMs,
    }
  }
  const path2 = route.path

  const serviceId = tls ? 'https' : 'http'
  const listening = isListening(server, serviceId) && port === (tls ? 443 : 80)

  if (!listening) {
    const steps = tcpRefused()
    steps[1]!.lines = [
      ...v(out(`* connect to ${r.ip} port ${port} from ${self(ctx).data.ip} port 0 failed: Connection refused`)),
      ...L(err(`curl: (7) Failed to connect to ${host} port ${port} after 2 ms: Couldn't connect to server`)),
    ]
    legs.push({ conv: newConversation(ctx.selfId, server.id, r.ip, port, steps), path: path2 })
    const run = runConversations(legs, ctx)
    return { ok: false, url, failure: 'refused', ip: r.ip, lines: [...immediate, ...run.lines], endMs: run.endMs }
  }

  // 3. TCP, (TLS), HTTP, close
  const body = pageFor(server, host, r.ip)
  const cert = tls ? certificateFor(host, server.data.certificate ?? 'valid') : undefined
  const problem = cert ? certProblem(cert, host) ?? undefined : undefined
  const conv = newConversation(ctx.selfId, server.id, r.ip, port, [])

  const open = tcpOpen()
  open[2]!.lines = [
    ...v(info(`ⓘ TCP three-way handshake: SYN → SYN-ACK → ACK (your port ${conv.clientPort} → server port ${port})`)),
    ...v(out(`* Connected to ${host} (${r.ip}) port ${port}`)),
  ]
  const helloLines = [
    ...v(out('* TLS handshake, Client hello (1):')),
    ...v(info(`ⓘ The Client hello names the site (${host}) in plain text.`)),
  ]
  const serverHelloLines = [
    ...v(out('* TLS handshake, Server hello (2):')),
    ...v(out('* TLS handshake, Certificate (11):')),
  ]

  // The certificate fails the check: the client sends an alert and hangs up (spec §3.3)
  if (cert && problem && !insecure) {
    const rejected = tlsRejected(host, cert, problem.verify)
    rejected[0]!.lines = helloLines
    rejected[1]!.lines = [
      ...serverHelloLines,
      ...v(out(`* ${problem.curl.replace(/^curl: \(60\) /, '')}`)),
      ...v(out('* Closing connection')),
      ...L(err(problem.curl)),
      ...L(info(`ⓘ ${problem.explain}`)),
    ]
    conv.steps = [...open, ...rejected, ...tcpClose()]
    legs.push({ conv, path: path2 })
    const run = runConversations(legs, ctx)
    return { ok: false, url, failure: 'cert', ip: r.ip, cert, problem, lines: [...immediate, ...run.lines], endMs: run.endMs }
  }

  const handshake = cert ? tlsHandshake(host, cert) : []
  if (cert) {
    handshake[0]!.lines = helloLines
    handshake[1]!.lines = serverHelloLines
    handshake[2]!.lines = [
      ...v(out('* TLS handshake, Finished (20):')),
      ...v(out('* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384')),
      ...v(info('ⓘ “SSL” here is a historical name: SSL is the deprecated predecessor of TLS. The protocol in use is TLS 1.3.')),
      ...v(out('* Server certificate:')),
      ...v(out(`*  subject: ${cert.subject}`)),
      ...v(out(`*  start date: ${formatCertDate(cert.start)}`)),
      ...v(out(`*  expire date: ${formatCertDate(cert.expire)}`)),
      ...v(out(`*  issuer: ${cert.issuer}`)),
      ...(problem
        ? [
            ...v(out(`*  SSL certificate verify result: ${problem.verify}, continuing anyway.`)),
            ...L(info(`ⓘ -k skipped the certificate check. ${problem.explain} The connection is still encrypted, but you can't be sure who is on the other end.`)),
          ]
        : v(out('*  SSL certificate verify ok.'))),
    ]
  }

  const method: HttpMethod = head ? 'HEAD' : 'GET'
  const redirectTo = !tls && server.data.deviceType === 'web' && server.data.redirectHttp
    ? `https://${host}${path}`
    : undefined
  const http = httpExchange(host, path, body, tls, userAgent, { method, redirectTo })
  const responseHeaders = httpResponseHeaders(body, redirectTo)
  http[0]!.lines = [
    ...httpRequestHeaders(host, path, userAgent, method).flatMap((h) => v(out(`> ${h}`))),
    ...v(out('>')),
    ...v(info(tls
      ? 'ⓘ Everything from here is encrypted on the wire. Open the packet capture to compare.'
      : 'ⓘ Everything you see below also crossed the network in plain text.')),
  ]
  http[1]!.lines = [
    // -v shows the headers as `< …`; -I alone prints them plain, the way curl does
    ...responseHeaders.flatMap((h) => (verbose ? v(out(`< ${h}`)) : head ? L(out(h)) : [])),
    ...v(out('<')),
    ...(withLines && !head && !redirectTo ? body.split('\n').map((line) => out(line)) : []),
    ...(redirectTo
      ? L(info(`ⓘ 301 Moved Permanently: the server says to use ${redirectTo} instead. curl stops here; a browser follows the redirect by itself. This first request still crossed the network in plain text.`))
      : []),
  ]

  const close = tcpClose()
  close[1]!.lines = v(out(`* Connection #0 to host ${host} left intact`))

  conv.steps = [...open, ...handshake, ...http, ...close]
  legs.push({ conv, path: path2 })
  const run = runConversations(legs, ctx)
  return { ok: true, url, ip: r.ip, body, cert, problem, redirect: redirectTo, lines: [...immediate, ...run.lines], endMs: run.endMs }
}

// ── curl ─────────────────────────────────────────────────────────────────────

export interface CurlFlags {
  verbose: boolean
  insecure: boolean
  head: boolean
  unknown: string[]
}

/** curl's flags: -v, -k, -I, combined (-vk) or long (--verbose, --insecure, --head). */
export function parseCurlFlags(flags: string[]): CurlFlags {
  const f: CurlFlags = { verbose: false, insecure: false, head: false, unknown: [] }
  const long: Record<string, keyof Omit<CurlFlags, 'unknown'>> = { '--verbose': 'verbose', '--insecure': 'insecure', '--head': 'head' }
  const short: Record<string, keyof Omit<CurlFlags, 'unknown'>> = { v: 'verbose', k: 'insecure', I: 'head' }
  for (const flag of flags) {
    if (flag.startsWith('--')) {
      const key = long[flag]
      if (key) f[key] = true
      else f.unknown.push(flag)
      continue
    }
    const letters = flag.slice(1).split('')
    if (letters.length && letters.every((c) => short[c])) letters.forEach((c) => { f[short[c]!] = true })
    else f.unknown.push(flag)
  }
  return f
}

export function cmdCurl(args: string[], ctx: TermContext, plain = false): Lines {
  const flags = plain ? [] : args.filter((a) => a.startsWith('-'))
  const rest = args.filter((a) => plain || !a.startsWith('-'))
  const url = rest[0]
  if (!url) return [err(plain ? 'Usage: wget <url>' : 'Usage: curl [-v] [-k] [-I] <url>   e.g. curl -v https://www.careconnect.example')]
  const f = parseCurlFlags(flags)
  const notes: Lines = f.unknown.length
    ? [info(`ⓘ ${f.unknown.join(' ')} is not available in Networx; ignoring.`)]
    : []
  return [...notes, ...fetchUrl(url, ctx, { verbose: f.verbose, insecure: f.insecure, head: f.head }).lines]
}
