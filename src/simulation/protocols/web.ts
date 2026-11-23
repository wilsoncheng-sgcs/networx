import type { NetNode, TerminalLine } from '../../types'
import { type TermContext, type Lines, out, err, info, self } from '../context'
import { resolveTarget, isResolveError, isIp } from '../resolve'
import { isListening } from '../services'
import {
  type Step, type CertInfo, type Leg,
  newConversation, tcpOpen, tcpRefused, tcpClose, tlsHandshake, certificateFor, formatCertDate,
  dnsConversation, runConversations, pathTo, byteLength,
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

export function httpRequestHeaders(host: string, path: string, userAgent = CURL_USER_AGENT): string[] {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    `User-Agent: ${userAgent}`,
    `Accept: ${userAgent === CURL_USER_AGENT ? '*/*' : 'text/html'}`,
  ]
}

export function httpResponseHeaders(body: string): string[] {
  return [
    'HTTP/1.1 200 OK',
    'Content-Type: text/html; charset=utf-8',
    `Content-Length: ${byteLength(body)}`,
  ]
}

/** One HTTP request and its 200 OK. With `tls`, the same bytes travel inside TLS (encrypted on the wire). */
export function httpExchange(host: string, path: string, body: string, tls = false, userAgent = CURL_USER_AGENT): Step[] {
  const request = httpRequestHeaders(host, path, userAgent).join('\n')
  const response = [...httpResponseHeaders(body), '', body].join('\n')
  if (tls) {
    return [
      { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: '🔒 GET', info: 'Application Data', payload: request, encrypted: true },
      { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: '🔒 200 OK', info: 'Application Data', payload: response, encrypted: true },
    ]
  }
  return [
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'HTTP', label: `GET ${path}`.slice(0, 14), info: `GET ${path} HTTP/1.1`, payload: request },
    { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'HTTP', label: '200 OK', info: 'HTTP/1.1 200 OK  (text/html)', payload: response },
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

export type WebFailure = 'bad-url' | 'nxdomain' | 'no-dns' | 'no-route' | 'refused'

export interface WebResult {
  ok: boolean
  url: ParsedUrl | null
  failure?: WebFailure
  ip?: string
  body?: string
  cert?: CertInfo
  lines: TerminalLine[]
  /** When the last packet arrives (ms): the browser shows the page then. */
  endMs: number
}

interface FetchOptions {
  verbose?: boolean
  userAgent?: string
  /** curl prints lines; the browser plays the same Conversations silently. */
  withLines?: boolean
}

export function fetchUrl(raw: string, ctx: TermContext, opts: FetchOptions = {}): WebResult {
  const { verbose = false, userAgent = CURL_USER_AGENT, withLines = true } = opts
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
    ...(isIp(host) ? [] : v(out(`* Host ${host}:${port} was resolved.`))),
    ...(isIp(host) ? [] : v(out(`* IPv4: ${r.ip}`))),
    ...v(out(`*   Trying ${r.ip}:${port}...`)),
  ]

  if (isResolveError(r)) {
    const failLines = r.error === 'no-route'
      ? L(err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: No route to host`))
      : L(err(`curl: (6) Could not resolve host: ${host}`))
    const dnsLeg = dnsConversation(r, ctx, failLines)
    if (!dnsLeg) return { ok: false, url, failure: r.error, lines: failLines, endMs: 0 }
    const run = runConversations([dnsLeg], ctx)
    return { ok: false, url, failure: r.error, lines: run.lines, endMs: run.endMs }
  }

  const dnsLeg = dnsConversation(r, ctx, resolvedLines)
  if (dnsLeg) legs.push(dnsLeg)
  const immediate: Lines = dnsLeg ? [] : resolvedLines

  // 2. Is anything listening on that port?
  const server = r.node
  const path2 = server ? pathTo(server, ctx) : null
  if (!server || !path2) {
    const failLines = L(err(`curl: (7) Failed to connect to ${host} port ${port} after 0 ms: No route to host`))
    if (dnsLeg) dnsLeg.conv.steps[1]!.lines = [...resolvedLines, ...failLines]
    const run = runConversations(legs, ctx)
    return { ok: false, url, failure: 'no-route', lines: [...immediate, ...run.lines, ...(dnsLeg ? [] : failLines)], endMs: run.endMs }
  }

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
  const cert = tls ? certificateFor(host) : undefined
  const conv = newConversation(ctx.selfId, server.id, r.ip, port, [])

  const open = tcpOpen()
  open[2]!.lines = [
    ...v(info(`ⓘ TCP three-way handshake: SYN → SYN-ACK → ACK (your port ${conv.clientPort} → server port ${port})`)),
    ...v(out(`* Connected to ${host} (${r.ip}) port ${port}`)),
  ]

  const handshake = cert ? tlsHandshake(host, cert) : []
  if (cert) {
    handshake[0]!.lines = [
      ...v(out('* TLS handshake, Client hello (1):')),
      ...v(info(`ⓘ The Client hello names the site (${host}) in plain text.`)),
    ]
    handshake[1]!.lines = [
      ...v(out('* TLS handshake, Server hello (2):')),
      ...v(out('* TLS handshake, Certificate (11):')),
    ]
    handshake[2]!.lines = [
      ...v(out('* TLS handshake, Finished (20):')),
      ...v(out('* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384')),
      ...v(info('ⓘ “SSL” here is a historical name: SSL is the deprecated predecessor of TLS. The protocol in use is TLS 1.3.')),
      ...v(out('* Server certificate:')),
      ...v(out(`*  subject: ${cert.subject}`)),
      ...v(out(`*  start date: ${formatCertDate(cert.start)}`)),
      ...v(out(`*  expire date: ${formatCertDate(cert.expire)}`)),
      ...v(out(`*  issuer: ${cert.issuer}`)),
      ...v(out('*  SSL certificate verify ok.')),
    ]
  }

  const http = httpExchange(host, path, body, tls, userAgent)
  http[0]!.lines = [
    ...httpRequestHeaders(host, path, userAgent).flatMap((h) => v(out(`> ${h}`))),
    ...v(out('>')),
    ...v(info(tls
      ? 'ⓘ Everything from here is encrypted on the wire. Open the packet capture to compare.'
      : 'ⓘ Everything you see below also crossed the network in plain text.')),
  ]
  http[1]!.lines = [
    ...httpResponseHeaders(body).flatMap((h) => v(out(`< ${h}`))),
    ...v(out('<')),
    ...(withLines ? body.split('\n').map((line) => out(line)) : []),
  ]

  const close = tcpClose()
  close[1]!.lines = v(out(`* Connection #0 to host ${host} left intact`))

  conv.steps = [...open, ...handshake, ...http, ...close]
  legs.push({ conv, path: path2 })
  const run = runConversations(legs, ctx)
  return { ok: true, url, ip: r.ip, body, cert, lines: [...immediate, ...run.lines], endMs: run.endMs }
}

// ── curl ─────────────────────────────────────────────────────────────────────

export function cmdCurl(args: string[], ctx: TermContext, plain = false): Lines {
  const flags = plain ? [] : args.filter((a) => a.startsWith('-'))
  const rest = args.filter((a) => plain || !a.startsWith('-'))
  const url = rest[0]
  if (!url) return [err(plain ? 'Usage: wget <url>' : 'Usage: curl [-v] <url>   e.g. curl -v https://www.careconnect.example')]
  const verbose = flags.some((f) => /^-[a-zA-Z]*v/.test(f) || f === '--verbose')
  const unsupported = flags.filter((f) => !/^-[a-zA-Z]*v[a-zA-Z]*$/.test(f) && f !== '--verbose')
  const notes: Lines = unsupported.length
    ? [info(`ⓘ ${unsupported.join(' ')} is not available in Networx yet; ignoring.`)]
    : []
  return [...notes, ...fetchUrl(url, ctx, { verbose }).lines]
}
