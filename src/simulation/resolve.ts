import type { NetNode, NetEdge, DnsRecord, DnsRecordType } from '../types'
import type { TermContext } from './context'
import { nodeById } from './network'
import { routeBetween, nodeHasIp, type Route, type Flow } from './routing'
import { isListening } from './services'
import { isPrivateIp } from './privateIp'
import { cacheGet, cachePut } from './dnsCache'
import { answerQuery, addressOf, normName, newTransactionId, PUBLIC_TTL, type AnswerRecord, type DnsAnswer } from './dns'

/** Well-known internet names, answered (non-authoritatively) when the local DNS server has no record. */
export const PUBLIC_IPS: Record<string, string> = {
  'google.com':      '142.250.185.46',
  'www.google.com':  '142.250.185.46',
  'youtube.com':     '142.250.68.110',
  'bbc.co.uk':       '151.101.0.81',
  'bbc.com':         '151.101.0.81',
  'example.com':     '93.184.216.34',
  'cloudflare.com':  '104.16.133.229',
  'github.com':      '140.82.121.4',
  'amazon.co.uk':    '54.239.28.85',
  'microsoft.com':   '20.112.52.29',
  'apple.com':       '17.253.144.10',
  'twitter.com':     '104.244.42.193',
  'x.com':           '104.244.42.193',
  'facebook.com':    '157.240.241.35',
  'wikipedia.org':   '208.80.154.224',
  'ocr.org.uk':      '213.219.152.175',
  'aqa.org.uk':      '23.55.180.103',
  'eduqas.co.uk':    '185.43.135.28',
}

/** The public resolver used when the network has no DNS server node but reaches the internet. */
export const PUBLIC_RESOLVER_IP = '8.8.8.8'

export function isIp(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)
}

type Failed = Extract<Route, { ok: false }>

/** A DNS query that got an answer: who answered, and the path the query and answer travel. */
export interface DnsQuery {
  server: NetNode
  serverIp: string
  path: string[]
  /** What was asked, and what came back. */
  qtype: DnsRecordType
  answer: DnsAnswer
  /** Transaction id, e.g. 0x1a2b. */
  id: string
}

/** A DNS server that never answered: how far the queries got, and why. */
export interface DnsTimeout {
  qtype: DnsRecordType
  serverIp: string
  server: NetNode | null
  route: Failed
}

export interface Resolved {
  name: string                 // what the user typed
  ip: string
  node: NetNode | null         // the node that answers for this IP (the cloud node for internet hosts)
  dnsServerNode: NetNode | null
  dnsServerIp: string | null
  authoritative: boolean
  /** The query to animate (absent when no DNS server was asked). */
  query?: DnsQuery
  /** Answered from this device's DNS cache: nothing was sent. */
  cached?: boolean
  /** DNS servers asked first that never answered (the alternate answered). */
  failedFirst?: DnsTimeout[]
}

export interface ResolveError {
  name: string
  /**
   * nxdomain: no such name · timeout: the DNS server didn't answer · no-dns: no DNS server set ·
   * servfail: the server couldn't answer (a CNAME loop) · nodata: the name has no A record ·
   * no-ipv4: the name only has an IPv6 (AAAA) address
   */
  error: 'nxdomain' | 'no-dns' | 'no-route' | 'timeout' | 'servfail' | 'nodata' | 'no-ipv4'
  dnsServerNode: NetNode | null
  dnsServerIp: string | null
  /** Why the name couldn't be looked up (an ⓘ line). */
  explain?: string
  query?: DnsQuery
  timeout?: DnsTimeout
  cached?: boolean
  failedFirst?: DnsTimeout[]
}

export type Resolution = Resolved | ResolveError

export function isResolveError(r: Resolution): r is ResolveError {
  return 'error' in r
}

/** The route from this device to `dst` answering on `dstIp`, under the address rules (routing.ts). */
export function routeTo(dst: NetNode | null, dstIp: string, ctx: TermContext, flow?: Flow): Route {
  const src = nodeById(ctx.selfId, ctx.nodes)
  if (!src) return { ok: false, failure: 'no-path', reach: null, explain: '' }
  if (dst && dst.data.isOn === false) {
    return { ok: false, failure: 'no-reply', reach: null, explain: `ⓘ ${dst.data.label} is switched off.` }
  }
  return routeBetween(src, dst, dstIp, ctx.nodes, ctx.edges, flow)
}

function reachable(node: NetNode | undefined, ip: string, ctx: TermContext): node is NetNode {
  return !!node && node.data.isOn !== false && routeTo(node, ip, ctx).ok
}

function reachableCloud(ctx: TermContext): NetNode | undefined {
  return ctx.nodes.find((n) => n.data.deviceType === 'cloud' && reachable(n, PUBLIC_RESOLVER_IP, ctx))
}

const publicIpSet = () => new Set(Object.values(PUBLIC_IPS))

/**
 * Which node answers for `ip`, as seen from this device. The same private address can exist in two
 * networks: prefer the one this device can actually reach. Public addresses Networx knows are the internet.
 * The node may still be unreachable — the caller checks the route and explains why.
 */
export function nodeForIp(ip: string, ctx: TermContext): NetNode | null {
  const candidates = ctx.nodes.filter((n) => n.data.deviceType !== 'cloud' && nodeHasIp(n, ip))
  if (candidates.length) return candidates.find((n) => routeTo(n, ip, ctx).ok) ?? candidates[0]!
  if (!publicIpSet().has(ip)) return null
  return reachableCloud(ctx) ?? ctx.nodes.find((n) => n.data.deviceType === 'cloud') ?? null
}

// ── Which DNS server a device asks ───────────────────────────────────────────

/**
 * The DNS server a device asks when none is set: the network's DNS server node (the first one this
 * device has a route to, else the first one); the public resolver 8.8.8.8 only when the network has
 * no DNS server node but has an Internet node; else none.
 */
export function defaultDnsServer(self: NetNode, nodes: NetNode[], edges: NetEdge[]): string {
  const dnsNodes = nodes.filter((n) => n.data.deviceType === 'dns' && n.data.ip)
  if (dnsNodes.length) {
    const routed = dnsNodes.find((n) => n.id === self.id || routeBetween(self, n, n.data.ip, nodes, edges).ok)
    return (routed ?? dnsNodes[0]!).data.ip
  }
  return nodes.some((n) => n.data.deviceType === 'cloud') ? PUBLIC_RESOLVER_IP : ''
}

/** The DNS servers this device asks, in order: its DNS server, then its alternate. */
export function dnsServersOf(ctx: TermContext): string[] {
  const me = nodeById(ctx.selfId, ctx.nodes)
  const alt = typeof me?.data.dnsAlternate === 'string' ? me.data.dnsAlternate.trim() : ''
  return [dnsServerIpOf(ctx), alt].filter((ip, i, all) => ip && all.indexOf(ip) === i)
}

/** The DNS server address this device is configured to ask ('' = none). */
export function dnsServerIpOf(ctx: TermContext): string {
  const me = nodeById(ctx.selfId, ctx.nodes)
  if (!me) return ''
  return typeof me.data.dnsServer === 'string' ? me.data.dnsServer.trim() : defaultDnsServer(me, ctx.nodes, ctx.edges)
}

/** The node that would answer DNS queries sent to `ip` (8.8.8.8 is the Internet node), or null. */
function dnsServerAt(ip: string, ctx: TermContext): NetNode | null {
  if (ip === PUBLIC_RESOLVER_IP) {
    return reachableCloud(ctx) ?? ctx.nodes.find((n) => n.data.deviceType === 'cloud') ?? null
  }
  const dns = ctx.nodes.filter((n) => n.data.deviceType === 'dns' && n.data.ip === ip)
  if (dns.length) return dns.find((n) => reachable(n, ip, ctx)) ?? dns[0]!
  return nodeForIp(ip, ctx)
}

/** Does this node answer DNS queries? (A DNS server node with its DNS service on, or the internet's resolver.) */
function answersDns(node: NetNode, ip: string): boolean {
  if (node.data.isOn === false) return false
  if (node.data.deviceType === 'cloud') return ip === PUBLIC_RESOLVER_IP
  return node.data.deviceType === 'dns' && isListening(node, 'dns')
}

/** Index on `path` of the last router before the destination (where an offline server's packets stop). */
function lastRouterIndex(path: string[], nodes: NetNode[]): number {
  for (let i = path.length - 2; i > 0; i--) {
    const t = nodes.find((n) => n.id === path[i])?.data.deviceType ?? ''
    if (['router', 'gateway', 'firewall', 'cloud'].includes(t)) return i
  }
  return path.length - 2
}

/**
 * Send a query to this device's DNS server: the path it takes, or how far it gets when nothing answers.
 * null when the device has no DNS server set.
 */
function askDnsServer(ctx: TermContext, qtype: DnsRecordType, serverOverride?: string):
  | { ok: true; server: NetNode; serverIp: string; path: string[] }
  | { ok: false; timeout: DnsTimeout; explain: string }
  | null {
  const src = nodeById(ctx.selfId, ctx.nodes)
  const serverIp = serverOverride ?? dnsServerIpOf(ctx)
  if (!src || !serverIp) return null
  const server = dnsServerAt(serverIp, ctx)
  const noAnswer = `ⓘ The DNS server ${serverIp} didn't answer, so the name couldn't be turned into an IP address. Connecting by IP address still works.`
  // Route to the server even if it is switched off: the queries still travel as far as they can
  const route: Route = server && server.id === src.id
    ? { ok: true, path: [src.id] }
    : routeBetween(src, server, serverIp, ctx.nodes, ctx.edges, { protocol: 'UDP', port: 53 })
  if (!route.ok) {
    // The client's own settings stop it (no address, no usable gateway): keep that explanation
    const clientSide = route.failure === 'no-address' || route.failure === 'net-unreachable'
      || (route.failure === 'host-unreachable' && route.arpFor !== serverIp)
    const failed: Failed = route.failure === 'no-path' ? { ...route, failure: 'no-reply' } : route
    const explain = clientSide
      ? `ⓘ Names can't be looked up: the DNS server (${serverIp}) can't be reached. ${route.explain.replace(/^ⓘ /, '')}`
      : route.failure === 'blocked' ? `${noAnswer} ${route.explain.replace(/^ⓘ /, '')}` : noAnswer
    return { ok: false, timeout: { qtype, serverIp, server, route: failed }, explain }
  }
  if (!server || !answersDns(server, serverIp)) {
    // Switched off: the last router can't hand the queries over. Not a DNS server: nothing answers on port 53.
    const off = !!server && server.data.isOn === false
    const reach = off ? route.path.slice(0, lastRouterIndex(route.path, ctx.nodes) + 1) : route.path
    return { ok: false, timeout: { qtype, serverIp, server, route: { ok: false, failure: 'no-reply', reach, explain: noAnswer } }, explain: noAnswer }
  }
  return { ok: true, server, serverIp, path: route.path }
}

/** The records a server holds itself (it is authoritative for these). The internet's resolver holds none. */
function zoneOf(server: NetNode, ctx: TermContext): DnsRecord[] {
  if (server.data.deviceType !== 'dns') return []
  const primary = primaryOf(server, ctx.nodes)
  // A secondary copies its primary's records while both are online, and keeps serving its copy if the primary goes down
  return primary && primary.data.isOn !== false ? primary.data.dnsRecords ?? [] : server.data.dnsRecords ?? []
}

/** The primary DNS server a secondary copies its records from, if it is one. */
export function primaryOf(server: NetNode, nodes: NetNode[]): NetNode | undefined {
  const ip = server.data.dnsPrimary?.trim()
  return ip ? nodes.find((n) => n.id !== server.id && n.data.deviceType === 'dns' && n.data.ip === ip) : undefined
}

/** The well-known internet names Networx knows, as A records. */
function publicRecords(name: string): AnswerRecord[] {
  const ip = PUBLIC_IPS[name]
  return ip ? [{ name, type: 'A', value: ip, ttl: PUBLIC_TTL }] : []
}

/**
 * Records a server can look up for names it doesn't hold. A DNS server node knows the well-known
 * internet names; the internet's resolver (8.8.8.8) also finds the records of DNS servers that are
 * on the internet (public addresses), like a recursive resolver would.
 */
function lookupElsewhere(server: NetNode, ctx: TermContext): (name: string) => AnswerRecord[] {
  if (server.data.deviceType !== 'cloud') return publicRecords
  const internetZones = ctx.nodes.filter((n) => n.data.deviceType === 'dns' && n.data.isOn !== false && n.data.ip && !isPrivateIp(n.data.ip))
  return (name) => {
    for (const z of internetZones) {
      const held = zoneOf(z, ctx).filter((r) => normName(r.name) === name)
      if (held.length) return held.map((r) => ({ name, type: r.type, value: r.value.trim(), ttl: r.ttl, ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}) }))
    }
    return publicRecords(name)
  }
}

/** What a server answers for `name` and `qtype`. */
export function serverAnswer(server: NetNode, name: string, qtype: DnsRecordType, ctx: TermContext): DnsAnswer {
  return answerQuery(zoneOf(server, ctx), lookupElsewhere(server, ctx), name, qtype)
}

/** The result of asking this device's DNS server one question. */
export type DnsLookup =
  | { kind: 'answer'; answer: DnsAnswer; query: DnsQuery; failedFirst?: DnsTimeout[] }
  /** From this device's cache: nothing sent; TTLs counted down; `remaining` seconds until it expires. */
  | { kind: 'cached'; answer: DnsAnswer; serverIp: string; remaining: number }
  | { kind: 'timeout'; timeout: DnsTimeout; explain: string; failedFirst?: DnsTimeout[] }
  | { kind: 'no-dns'; explain: string }

export interface LookupOptions {
  /** Ask this server instead of the device's own (dig @server). Bypasses the cache. */
  serverIp?: string
  /** Use and fill this device's DNS cache (default true). nslookup asks the server every time. */
  useCache?: boolean
}

/** Ask this device's DNS server (or `opts.serverIp`) for `qtype` records of `name` — or its cache. */
export function lookupName(name: string, qtype: DnsRecordType, ctx: TermContext, opts: LookupOptions = {}): DnsLookup {
  const useCache = opts.useCache !== false && !opts.serverIp
  if (useCache) {
    const hit = cacheGet(ctx.selfId, name, qtype)
    if (hit) return { kind: 'cached', answer: hit.answer, serverIp: hit.serverIp, remaining: hit.remaining }
  }
  // The DNS server first; if it never answers (three tries), the alternate
  const servers = opts.serverIp ? [opts.serverIp] : dnsServersOf(ctx)
  if (!servers.length) {
    const me = nodeById(ctx.selfId, ctx.nodes)
    return { kind: 'no-dns', explain: `ⓘ ${me?.data.label ?? 'This device'} has no DNS server to ask, so names can't be turned into IP addresses. Connecting by IP address still works.` }
  }
  const failedFirst: DnsTimeout[] = []
  for (const [i, serverIp] of servers.entries()) {
    const asked = askDnsServer(ctx, qtype, serverIp)!
    if (!asked.ok) {
      if (i < servers.length - 1) { failedFirst.push(asked.timeout); continue }
      const explain = failedFirst.length
        ? `ⓘ Neither DNS server answered (${servers.join(', ')}), so the name couldn't be turned into an IP address. Connecting by IP address still works.`
        : asked.explain
      return { kind: 'timeout', timeout: asked.timeout, explain, ...(failedFirst.length ? { failedFirst } : {}) }
    }
    const answer = serverAnswer(asked.server, name, qtype, ctx)
    if (useCache) cachePut(ctx.selfId, name, qtype, answer, asked.serverIp)
    const query = { server: asked.server, serverIp: asked.serverIp, path: asked.path, qtype, answer, id: newTransactionId() }
    return { kind: 'answer', answer, query, ...(failedFirst.length ? { failedFirst } : {}) }
  }
  throw new Error('unreachable')
}

/**
 * Resolve a name or IP the way every command does (spec §2.5, Phase 4 A1/B2).
 * The device asks its DNS server for the name's A record (following CNAMEs); it never invents an
 * address, and never quietly asks another server: an unknown name is NXDOMAIN, a server that doesn't
 * answer is a timeout. Connections use IPv4 only.
 */
export function resolveTarget(nameOrIp: string, ctx: TermContext): Resolution {
  const name = nameOrIp
  if (isIp(nameOrIp)) {
    // No DNS needed. node is null when no device has this address (the route check explains it)
    return { name, ip: nameOrIp, node: nodeForIp(nameOrIp, ctx), dnsServerNode: null, dnsServerIp: null, authoritative: true }
  }

  const looked = lookupName(nameOrIp, 'A', ctx)
  if (looked.kind === 'no-dns') return { name, error: 'no-dns', dnsServerNode: null, dnsServerIp: null, explain: looked.explain }
  if (looked.kind === 'timeout') {
    return { name, error: 'timeout', dnsServerNode: looked.timeout.server, dnsServerIp: looked.timeout.serverIp, explain: looked.explain, timeout: looked.timeout, failedFirst: looked.failedFirst }
  }
  const answer = looked.answer
  const query = looked.kind === 'answer' ? looked.query : undefined
  const asked = query
    ? { name, dnsServerNode: query.server, dnsServerIp: query.serverIp, query, failedFirst: looked.kind === 'answer' ? looked.failedFirst : undefined }
    : { name, dnsServerNode: null, dnsServerIp: null, cached: true }
  if (answer.status === 'NXDOMAIN') return { ...asked, error: 'nxdomain' }
  if (answer.status === 'SERVFAIL') {
    return { ...asked, error: 'servfail', explain: `ⓘ The DNS server couldn't answer for ${name} (SERVFAIL): its CNAME records go round in a loop, or the chain is too long.` }
  }
  const ip = addressOf(answer)
  if (!ip) {
    const server = query?.server ?? (looked.kind === 'cached' ? dnsServerAt(looked.serverIp, ctx) : null)
    const v6 = !!server && serverAnswer(server, name, 'AAAA', ctx).records.some((r) => r.type === 'AAAA')
    return v6
      ? { ...asked, error: 'no-ipv4', explain: 'ⓘ This name only has an IPv6 address (AAAA record); Networx connects over IPv4 only.' }
      : { ...asked, error: 'nodata', explain: `ⓘ ${name} exists, but has no A record, so there is no IPv4 address to connect to.` }
  }
  return { ...asked, ip, node: nodeForIp(ip, ctx), authoritative: answer.authoritative }
}
