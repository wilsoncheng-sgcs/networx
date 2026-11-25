import type { NetNode, NetEdge, DnsRecord, DnsRecordType } from '../types'
import type { TermContext } from './context'
import { nodeById } from './network'
import { routeBetween, nodeHasIp, type Route, type Flow } from './routing'
import { isListening } from './services'
import { isPrivateIp } from './privateIp'
import { cacheGet, cachePut, serverCacheId } from './dnsCache'
import { answerQuery, addressOf, normName, newTransactionId, PUBLIC_TTL, type AnswerRecord, type DnsAnswer } from './dns'

/**
 * How long a DNS server waits for its forwarder before giving up and answering SERVFAIL (one query).
 * 3 s is Windows DNS Server's default forwarder timeout; it is shorter than the client's own 5 s
 * wait, so the client never has to send its query again.
 */
export const FORWARD_TIMEOUT_MS = 3000

/** Well-known internet names, which the public resolver (8.8.8.8) can look up. */
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
  /** The server didn't hold the name, so it asked its forwarder before answering. */
  forwarded?: Forwarded
  /** The server answered from its own cache of what its forwarder told it earlier (nothing sent upstream). */
  fromServerCache?: { forwarderIp: string }
  /** The server doesn't hold the name and has no forwarder (REFUSED). */
  noForwarder?: boolean
}

/** A DNS server asking its forwarder about a name it doesn't hold. */
export interface Forwarded {
  /** The name it asked about (the name asked, or where one of its CNAMEs points). */
  name: string
  qtype: DnsRecordType
  forwarderIp: string
  /** The forwarder answered (it may have asked its own forwarder in turn). */
  query?: DnsQuery
  /** The forwarder never answered: the query went this far. The server answered SERVFAIL. */
  timeout?: DnsTimeout
  /** Why the forwarder never answered (an ⓘ line). */
  explain?: string
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
   * servfail: the server couldn't answer (a CNAME loop, or its forwarder didn't answer) ·
   * refused: the server won't look up names it doesn't hold (no forwarder) · nodata: the name has no A record ·
   * no-ipv4: the name only has an IPv6 (AAAA) address
   */
  error: 'nxdomain' | 'no-dns' | 'no-route' | 'timeout' | 'servfail' | 'refused' | 'nodata' | 'no-ipv4'
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
      : route.failure === 'blocked' || route.failure === 'no-route' ? `${noAnswer} ${route.explain.replace(/^ⓘ /, '')}` : noAnswer
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

/**
 * The domains a DNS server is authoritative for: the names of its NS records; with none, the last two
 * labels of each name it holds (the rule dig +trace uses). It answers every name in them itself.
 */
function ownDomains(server: NetNode, ctx: TermContext): string[] {
  const zone = zoneOf(server, ctx)
  const ns = zone.filter((r) => r.type === 'NS').map((r) => normName(r.name))
  if (ns.length) return [...new Set(ns)]
  return [...new Set(zone.map((r) => normName(r.name).split('.').slice(-2).join('.')).filter(Boolean))]
}

function inDomains(name: string, domains: string[]): boolean {
  const n = normName(name)
  return domains.some((d) => n === d || n.endsWith(`.${d}`))
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
 * Records the internet's resolver (8.8.8.8) can look up: those held by DNS servers on the internet
 * (public addresses), like a recursive resolver would find them, and the well-known internet names.
 */
function lookupElsewhere(server: NetNode, ctx: TermContext): (name: string) => AnswerRecord[] {
  if (server.data.deviceType !== 'cloud') return () => []
  const internetZones = ctx.nodes.filter((n) => n.data.deviceType === 'dns' && n.data.isOn !== false && n.data.ip && !isPrivateIp(n.data.ip))
  return (name) => {
    for (const z of internetZones) {
      const held = zoneOf(z, ctx).filter((r) => normName(r.name) === name)
      if (held.length) return held.map((r) => ({ name, type: r.type, value: r.value.trim(), ttl: r.ttl, ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}) }))
    }
    return publicRecords(name)
  }
}

/** What a server answers, and what it did to find out. */
type ServerResult = { answer: DnsAnswer } & Pick<DnsQuery, 'forwarded' | 'fromServerCache' | 'noForwarder'>

interface AskOptions {
  /** Fill the servers' caches with what their forwarders answer (a real lookup, not a peek). */
  commit: boolean
  /** The DNS servers already waiting on this lookup (a forwarder pointing back at one is a loop). */
  chain: string[]
}

/** Only the fields that are set, so results compare and spread cleanly. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * What `server` answers for `name` and `qtype`. A DNS server node answers names it holds, and names in
 * its own domains, itself; any other name it asks its forwarder (or finds in its cache of earlier
 * answers). The internet's resolver (8.8.8.8) looks names up itself.
 */
function resolveAt(server: NetNode, name: string, qtype: DnsRecordType, ctx: TermContext, o: AskOptions): ServerResult {
  if (server.data.deviceType !== 'dns') return { answer: answerQuery(zoneOf(server, ctx), lookupElsewhere(server, ctx), name, qtype) }
  const domains = ownDomains(server, ctx)
  let how: Omit<ServerResult, 'answer'> = {}
  const answer = answerQuery(zoneOf(server, ctx), () => [], name, qtype, {
    // The root ('.') is never forwarded: a DNS server knows the root servers from its built-in root hints
    inZone: (n) => n === '' || inDomains(n, domains),
    forward: (n) => {
      const { answer: up, ...rest } = forward(server, n, qtype, ctx, o)
      how = rest
      return up
    },
  })
  return { answer, ...defined(how) }
}

/** `server` asks its forwarder about `name` (or answers from its cache of what the forwarder said before). */
function forward(server: NetNode, name: string, qtype: DnsRecordType, ctx: TermContext, o: AskOptions): ServerResult {
  const forwarderIp = (server.data.dnsForwarder ?? '').trim()
  if (!forwarderIp) return { answer: { status: 'REFUSED', records: [], authoritative: false }, noForwarder: true }
  const cacheId = serverCacheId(server.id)
  const hit = cacheGet(cacheId, name, qtype)
  if (hit) return { answer: hit.answer, fromServerCache: { forwarderIp: hit.serverIp } }

  const servfail: DnsAnswer = { status: 'SERVFAIL', records: [], authoritative: false }
  // The query leaves the DNS server, from its own address: route it as if the server sent it
  const sctx: TermContext = { ...ctx, selfId: server.id }
  const asked = askDnsServer(sctx, qtype, forwarderIp)!
  const label = server.data.label
  const gaveUp = `so after ${FORWARD_TIMEOUT_MS / 1000} s ${label} gave up and answered SERVFAIL. Names ${label} holds itself still work.`
  if (!asked.ok) {
    const why = asked.timeout.route.explain.replace(/^ⓘ /, '')
    const noAnswer = /didn't answer, so the name couldn't be turned/.test(why)
    const explain = `ⓘ ${label} doesn't hold ${normName(name)}, so it asked its forwarder ${forwarderIp} — which didn't answer, ${gaveUp}${why && !noAnswer ? ` ${why}` : ''}`
    return { answer: servfail, forwarded: { name, qtype, forwarderIp, timeout: asked.timeout, explain } }
  }
  if (asked.server.id === server.id || o.chain.includes(asked.server.id)) {
    // Forwarders that point back at each other: the query goes round, and nobody answers
    const explain = `ⓘ ${label} doesn't hold ${normName(name)}, so it asked its forwarder ${forwarderIp} — but that forwards back to ${label} (a forwarding loop), so nobody answered, ${gaveUp}`
    const timeout: DnsTimeout = { qtype, serverIp: forwarderIp, server: asked.server, route: { ok: false, failure: 'no-reply', reach: asked.path, explain } }
    return { answer: servfail, forwarded: { name, qtype, forwarderIp, timeout, explain } }
  }
  const { answer: got, ...how } = resolveAt(asked.server, name, qtype, sctx, { ...o, chain: [...o.chain, server.id] })
  const query: DnsQuery = { server: asked.server, serverIp: asked.serverIp, path: asked.path, qtype, answer: got, id: newTransactionId(), ...defined(how) }
  // A forwarder that refuses gives this server nothing to pass on: it fails the query
  const answer: DnsAnswer = got.status === 'REFUSED' ? servfail : { ...got, authoritative: false }
  if (o.commit) cachePut(cacheId, name, qtype, answer, forwarderIp)
  return { answer, forwarded: { name, qtype, forwarderIp, query } }
}

/** What a server answers for `name` and `qtype` (a peek: no cache is filled). */
export function serverAnswer(server: NetNode, name: string, qtype: DnsRecordType, ctx: TermContext): DnsAnswer {
  return resolveAt(server, name, qtype, ctx, { commit: false, chain: [] }).answer
}

/**
 * Why a lookup failed, as an ⓘ line, from what the server did: its forwarder never answered, it has
 * no forwarder, or a server further up a chain of forwarders failed. null when forwarding wasn't the reason.
 */
export function forwardExplain(q: DnsQuery | undefined): string | null {
  if (!q) return null
  if (q.noForwarder) return `ⓘ REFUSED: ${q.server.data.label} doesn't hold that name and has no forwarder set, so it won't look it up for you. Set a forwarder on its Configure panel, or add a record for the name.`
  const f = q.forwarded
  if (!f) return null
  if (f.explain) return f.explain
  const up = f.query
  if (up && (up.answer.status === 'SERVFAIL' || up.answer.status === 'REFUSED')) {
    const why = forwardExplain(up)
    return `ⓘ ${q.server.data.label} asked its forwarder ${f.forwarderIp}, which couldn't answer either (${up.answer.status}), so it answered SERVFAIL.${why ? ` ${why.replace(/^ⓘ /, '')}` : ''}`
  }
  return null
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
    const { answer, ...how } = resolveAt(asked.server, name, qtype, ctx, { commit: true, chain: [] })
    if (useCache) cachePut(ctx.selfId, name, qtype, answer, asked.serverIp)
    const query: DnsQuery = { server: asked.server, serverIp: asked.serverIp, path: asked.path, qtype, answer, id: newTransactionId(), ...defined(how) }
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
  if (answer.status === 'REFUSED') {
    return { ...asked, error: 'refused', explain: forwardExplain(query) ?? `ⓘ The DNS server refused to look up ${name} (REFUSED).` }
  }
  if (answer.status === 'SERVFAIL') {
    return { ...asked, error: 'servfail', explain: forwardExplain(query) ?? `ⓘ The DNS server couldn't answer for ${name} (SERVFAIL): its CNAME records go round in a loop, or the chain is too long.` }
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
