import type { DnsRecordType, TerminalLine } from '../../types'
import { type TermContext, type Lines, out, err, info, delayLines } from '../context'
import { lookupName, isIp, resolveTarget, isResolveError, dnsServerIpOf, routeTo, serverAnswer, forwardExplain, PUBLIC_IPS, FORWARD_TIMEOUT_MS, type DnsLookup, type DnsQuery } from '../resolve'
import { playLookup } from '../lookup'
import { newConversation, runConversations, dnsSteps, type Leg } from '../exchange'
import { RECORD_TYPES, digLine, fqdn, rdata, messageSize, normName, newTransactionId, type DnsAnswer, type AnswerRecord } from '../dns'
import type { NetNode } from '../../types'
import { nodeById } from '../network'
import { cacheEntries, flushDnsCache, serverCacheId } from '../dnsCache'

/**
 * dig and nslookup (Phase 4 B3). Both ask this device's DNS server (or the one named with @) and
 * animate the query and its answer; their output follows macOS's dig 9.10 and nslookup.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** dig's WHEN line: `Tue Nov 24 12:00:00 AEDT 2026`, in this computer's time zone. */
export function digWhen(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  let tz = ''
  try {
    tz = new Intl.DateTimeFormat('en-AU', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? ''
  } catch { /* no Intl time zones */ }
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${tz ? ` ${tz}` : ''} ${d.getFullYear()}`
}

function parseType(s: string | undefined): DnsRecordType | null {
  const t = s?.toUpperCase()
  return t && (RECORD_TYPES as string[]).includes(t) ? (t as DnsRecordType) : null
}

/** How the server found a non-authoritative answer, in one ⓘ line (the "no aa flag" note). */
function lookedUpNote(query: DnsQuery | undefined): string {
  if (!query) return 'ⓘ No aa flag: the server looked the answer up elsewhere for you, so it is not authoritative.'
  const label = query.server.data.label
  if (query.fromServerCache) {
    return `ⓘ No aa flag: ${label} doesn't hold this name. It answered from its own cache of what its forwarder (${query.fromServerCache.forwarderIp}) told it earlier, so nothing more was sent upstream.`
  }
  if (query.forwarded?.query) {
    return `ⓘ No aa flag: ${label} doesn't hold this name, so it asked its forwarder (${query.forwarded.forwarderIp}) and passed the answer on. It keeps the answer in its cache until the TTL runs out.`
  }
  if (query.server.data.deviceType === 'cloud') return `ⓘ No aa flag: ${query.serverIp} is a public resolver. It looked the answer up for you, so it is not authoritative.`
  return 'ⓘ No aa flag: the server looked the answer up elsewhere for you, so it is not authoritative.'
}

/** Plain-language notes after an answer: one per record type, the TTLs, and what the flags mean. */
export function answerNotes(name: string, qtype: DnsRecordType, answer: DnsAnswer, cached = false, query?: DnsQuery): string[] {
  const notes: string[] = []
  const fromCache = 'ⓘ Answered from this device\'s cache — nothing was sent. It stays cached until the TTL runs out.'
  const n = normName(name)
  const forwarded = query?.forwarded?.query || query?.fromServerCache
  if (answer.status === 'NXDOMAIN') {
    const where = forwarded
      ? `${query!.server.data.label} doesn't hold ${n}, and its forwarder found no records for it either.`
      : `the DNS server has no records for ${n}.`
    return [`ⓘ NXDOMAIN: no such name — ${where}`, ...(cached ? [fromCache] : [])]
  }
  if (answer.status === 'REFUSED') return [forwardExplain(query) ?? 'ⓘ REFUSED: the server won\'t look up names it doesn\'t hold.']
  if (answer.status === 'SERVFAIL') return [forwardExplain(query) ?? "ⓘ SERVFAIL: the server couldn't answer — the CNAME records go round in a loop, or the chain is too long."]
  if (!answer.records.length) return [`ⓘ NOERROR but no answer: ${n} exists, but has no ${qtype} record.`, ...(cached ? [fromCache] : [])]
  const first = (t: DnsRecordType) => answer.records.find((r) => r.type === t)
  // In the order the records appear (a CNAME, then what it points to)
  for (const t of [...new Set(answer.records.map((r) => r.type))]) {
    const r = first(t)!
    switch (t) {
      case 'CNAME': notes.push(`ⓘ CNAME: ${r.name} is an alias for ${normName(r.value)}, so the resolver looked that name up too.`); break
      case 'A': notes.push(`ⓘ A: the IPv4 address of ${r.name}.`); break
      case 'AAAA': notes.push(`ⓘ AAAA: the IPv6 address of ${r.name} (128 bits, written in hexadecimal). Networx connects over IPv4 only.`); break
      case 'MX': notes.push(`ⓘ MX: email for ${r.name} is delivered to ${normName(r.value)} (if there are several, the lowest priority number is tried first).`); break
      case 'NS': notes.push(`ⓘ NS: ${normName(r.value)} is the name server that holds ${r.name}'s records — it is authoritative for them.`); break
      case 'TXT': notes.push(/v=spf1/i.test(r.value)
        ? `ⓘ TXT: free text. This one is an SPF record: it lists which servers may send email for ${r.name}.`
        : 'ⓘ TXT: free text, e.g. email anti-spoofing (SPF) or proof that you own the domain.'); break
    }
  }
  const ttls = [...new Set(answer.records.map((r) => r.ttl))].sort((a, b) => a - b)
  notes.push(ttls.length === 1
    ? `ⓘ ${ttls[0]} is a TTL: how many seconds a resolver may keep this answer in its cache.`
    : `ⓘ ${ttls.slice(0, -1).join(', ')} and ${ttls[ttls.length - 1]} are TTLs: how many seconds a resolver may keep this answer in its cache.`)
  notes.push(cached ? fromCache : answer.authoritative
    ? 'ⓘ aa (authoritative answer): this server holds these records itself.'
    : lookedUpNote(query))
  return notes
}

/** The DNS server's address for an @server argument (an IP, or a name looked up first). */
function serverFromArg(arg: string, ctx: TermContext): { ip: string } | { error: Lines } {
  if (isIp(arg)) return { ip: arg }
  const r = resolveTarget(arg, ctx)
  return isResolveError(r) ? { error: [err(`dig: couldn't get address for '${arg}': not found`)] } : { ip: r.ip }
}

function queryTimeMs(path: string[], ctx: TermContext): number {
  const crosses = path.some((id) => nodeById(id, ctx.nodes)?.data.deviceType === 'cloud')
  return Math.max(1, (path.length - 1) * 2 + (crosses ? 10 : 0))
}

/** dig's Query time for a query: there and back, plus the server's own query to its forwarder (or its wait for one). */
function totalQueryMs(q: DnsQuery, ctx: TermContext): number {
  const f = q.forwarded
  const upstream = f?.query ? totalQueryMs(f.query, ctx) : f?.timeout ? FORWARD_TIMEOUT_MS : 0
  return queryTimeMs(q.path, ctx) + upstream
}

export function cmdDig(args: string[], ctx: TermContext): Lines {
  const flags = args.filter((a) => a.startsWith('+'))
  const at = args.find((a) => a.startsWith('@'))
  const rest = args.filter((a) => !a.startsWith('+') && !a.startsWith('@'))
  const short = flags.includes('+short')
  let qtype: DnsRecordType = 'A'
  let name = ''
  for (const a of rest) {
    const t = parseType(a)
    if (t && name) qtype = t
    else if (!name) name = a
    else if (t) qtype = t
  }
  if (!name) return [err('Usage: dig [@server] <name> [A|AAAA|CNAME|MX|NS|TXT] [+short] [+trace]')]

  let serverIp: string | undefined
  if (at) {
    const s = serverFromArg(at.slice(1), ctx)
    if ('error' in s) return s.error
    serverIp = s.ip
  }
  const banner = [out(`; <<>> DiG 9.10.6 <<>> ${args.join(' ')}`), out(';; global options: +cmd')]
  if (flags.includes('+trace')) return digTrace(name, qtype, ctx, banner)
  const looked = lookupName(name, qtype, ctx, { serverIp })
  if (looked.kind === 'cached') return digAnswer(name, qtype, looked, { short, banner, ctx })
  if (looked.kind !== 'answer') {
    const fail = [err(';; connection timed out; no servers could be reached'), info(looked.explain)]
    if (looked.kind === 'no-dns') return [...(short ? [] : banner), ...fail]
    return [...(short ? [] : banner), ...playLookup({ name, timeout: looked.timeout, failedFirst: looked.failedFirst }, ctx, fail).lines]
  }
  return playLookup({ name, query: looked.query, failedFirst: looked.failedFirst }, ctx, digAnswer(name, qtype, looked, { short, banner, ctx })).lines
}

function digAnswer(name: string, qtype: DnsRecordType, looked: Extract<DnsLookup, { kind: 'answer' | 'cached' }>, o: { short: boolean; banner: Lines; ctx: TermContext }): Lines {
  const answer = looked.answer
  const cached = looked.kind === 'cached'
  const id = cached ? Math.floor(Math.random() * 0x10000) : parseInt(looked.query.id, 16)
  const serverIp = cached ? looked.serverIp : looked.query.serverIp
  const records: AnswerRecord[] = answer.records
  if (o.short) return records.map((r) => out(rdata(r)))
  const flags = `qr${answer.authoritative ? ' aa' : ''} rd ra`
  return [
    ...o.banner,
    out(';; Got answer:'),
    out(`;; ->>HEADER<<- opcode: QUERY, status: ${answer.status}, id: ${id}`),
    out(`;; flags: ${flags}; QUERY: 1, ANSWER: ${records.length}, AUTHORITY: 0, ADDITIONAL: 1`),
    out(''),
    out(';; QUESTION SECTION:'),
    out(`;${fqdn(name)}\t\tIN\t${qtype}`),
    out(''),
    ...(records.length ? [out(';; ANSWER SECTION:'), ...records.map((r) => out(digLine(r))), out('')] : []),
    out(`;; Query time: ${cached ? 0 : totalQueryMs(looked.query, o.ctx)} msec`),
    out(`;; SERVER: ${serverIp}#53(${serverIp})`),
    out(`;; WHEN: ${digWhen()}`),
    out(`;; MSG SIZE  rcvd: ${messageSize(name, records)}`),
    out(''),
    ...answerNotes(name, qtype, answer, cached, cached ? undefined : looked.query).map((t) => info(t)),
  ]
}

// ── nslookup ─────────────────────────────────────────────────────────────────

/** One answer line in nslookup's style. */
function nslookupLine(r: AnswerRecord): TerminalLine[] {
  switch (r.type) {
    case 'A': return [out(`Name:     ${r.name}`), out(`Address:  ${r.value}`)]
    case 'AAAA': return [out(`${r.name}\thas AAAA address ${r.value}`)]
    case 'CNAME': return [out(`${r.name}\tcanonical name = ${fqdn(r.value)}`)]
    case 'MX': return [out(`${r.name}\tmail exchanger = ${r.priority ?? 10} ${fqdn(r.value)}`)]
    case 'NS': return [out(`${r.name}\tnameserver = ${fqdn(r.value)}`)]
    case 'TXT': return [out(`${r.name}\ttext = ${rdata(r)}`)]
  }
}

export function cmdNslookup(args: string[], ctx: TermContext): Lines {
  const opt = args.find((a) => /^-(type|query|q)=/i.test(a))
  const domain = args.find((a) => !a.startsWith('-'))
  const qtype = opt ? parseType(opt.split('=')[1]) : 'A'
  if (!domain || !qtype) return [err('Usage: nslookup [-type=A|AAAA|CNAME|MX|NS|TXT] <name>')]
  const timedOut = (explain: string): Lines => [err(';; connection timed out; no servers could be reached'), info(explain)]

  if (isIp(domain)) {
    // Reverse lookup needs PTR records, which Networx's DNS server doesn't hold
    const serverIp = dnsServerIpOf(ctx)
    if (!serverIp) return [out('Server:   (none)'), out(''), err(';; connection timed out; no servers could be reached')]
    const arpa = `${domain.split('.').reverse().join('.')}.in-addr.arpa`
    return [out(`Server:   ${serverIp}`), out(`Address:  ${serverIp}#53`), out(''), out(`** server can't find ${arpa}: NXDOMAIN`)]
  }

  const looked = lookupName(domain, qtype, ctx, { useCache: false })
  if (looked.kind === 'cached') return []
  if (looked.kind === 'no-dns') return [out('Server:   (none)'), out(''), ...timedOut(looked.explain)]
  if (looked.kind === 'timeout') return playLookup({ name: domain, timeout: looked.timeout, failedFirst: looked.failedFirst }, ctx, timedOut(looked.explain)).lines

  const { answer, query } = looked
  const lines: Lines = [out(`Server:   ${query.serverIp}`), out(`Address:  ${query.serverIp}#53`), out('')]
  if (answer.status === 'NXDOMAIN') lines.push(out(`** server can't find ${domain}: NXDOMAIN`))
  else if (answer.status === 'SERVFAIL' || answer.status === 'REFUSED') lines.push(out(`** server can't find ${domain}: ${answer.status}`))
  else if (!answer.records.length) lines.push(out(`*** Can't find ${domain}: No answer`))
  else {
    if (!answer.authoritative) lines.push(out('Non-authoritative answer:'))
    for (const r of answer.records) lines.push(...nslookupLine(r))
  }
  const why = forwardExplain(query)
  if (why && answer.status !== 'NOERROR' && answer.status !== 'NXDOMAIN') lines.push(info(why))
  const end = playLookup({ name: domain, query, failedFirst: looked.failedFirst }, ctx).endMs
  return delayLines(lines, end)
}


// ── The device's DNS cache ──────────────────────────────────────────────────

function cacheTable(entries: ReturnType<typeof cacheEntries>): Lines {
  const lines: Lines = [out(`${'Name'.padEnd(30)}${'Type'.padEnd(7)}${'TTL left'.padEnd(10)}Answer`)]
  for (const e of entries) {
    const shown = e.answer.status !== 'NOERROR' ? e.answer.status
      : e.answer.records.length ? e.answer.records.map((r) => (r.type === e.qtype ? rdata(r) : `${rdata(r)} (${r.type})`)).join(', ')
      : 'no record of this type'
    lines.push(out(`${e.name.padEnd(30)}${e.qtype.padEnd(7)}${`${e.remaining} s`.padEnd(10)}${shown}`))
  }
  return lines
}

export function cmdDnsCache(ctx: TermContext): Lines {
  const me = nodeById(ctx.selfId, ctx.nodes)
  const label = me?.data.label ?? 'this device'
  const entries = cacheEntries(ctx.selfId)
  const lines: Lines = entries.length
    ? [out(`DNS cache on ${label}:`), ...cacheTable(entries),
       info('ⓘ Each answer is kept until its TTL runs out, then the device asks its DNS server again. flushdns empties the cache.')]
    : [out(`The DNS cache on ${label} is empty.`)]
  if (me?.data.deviceType === 'dns') {
    // A DNS server also keeps what its forwarder told it, to answer other devices
    const served = cacheEntries(serverCacheId(ctx.selfId))
    lines.push(out(''), ...(served.length
      ? [out(`Answers ${label} got from its forwarder:`), ...cacheTable(served),
         info('ⓘ The server answers these from its cache until the TTL runs out, without asking its forwarder again.')]
      : [out(`${label} has no answers from its forwarder cached.`)]))
  }
  return lines
}

export function cmdFlushDns(ctx: TermContext, quiet = false): Lines {
  flushDnsCache(ctx.selfId)
  const me = nodeById(ctx.selfId, ctx.nodes)
  const isServer = me?.data.deviceType === 'dns'
  if (isServer) flushDnsCache(serverCacheId(ctx.selfId))
  if (quiet) return []
  return [info(isServer
    ? `Flushed the DNS caches on ${me!.data.label}: its own, and the answers it got from its forwarder. The next lookup of a name it doesn't hold asks the forwarder again.`
    : `Flushed the DNS cache on ${me?.data.label ?? 'this device'}. The next lookup asks the DNS server again.`)]
}

// ── dig +trace (Phase 4 B5) ──────────────────────────────────────────────────

/** The 13 root server names (a to m). Only a.root-servers.net's address is shown (198.41.0.4, its real one). */
const ROOT_SERVERS = 'abcdefghijklm'.split('').map((l) => `${l}.root-servers.net`)
const ROOT_A_IP = '198.41.0.4'
const ROOT_NS_TTL = 518400
const TLD_NS_TTL = 172800
/** Simulated top-level-domain servers: made-up names on TEST-NET-1 (192.0.2.0/24, RFC 5737). */
const TLD_IPS: Record<string, string> = { example: '192.0.2.10', com: '192.0.2.11', org: '192.0.2.12', uk: '192.0.2.13', au: '192.0.2.14' }
const tldServer = (tld: string) => ({ name: tld === 'example' ? 'a.tld-servers.example' : `a.${tld}-servers.example`, ip: TLD_IPS[tld] ?? '192.0.2.15' })

/** The DNS server node that holds `name`'s zone, and the zone's apex and name server. */
function authorityFor(name: string, ctx: TermContext): { node: NetNode; zone: string; ns: string; nsTtl: number } | null {
  const n = normName(name)
  let best: { node: NetNode; zone: string; ns: string; nsTtl: number } | null = null
  // Prefer a server that is on (a secondary answers when the primary is off)
  const dnsNodes = ctx.nodes.filter((x) => x.data.deviceType === 'dns' && x.data.ip).sort((a, b) => Number(a.data.isOn === false) - Number(b.data.isOn === false))
  for (const node of dnsNodes) {
    const records = node.data.dnsRecords ?? []
    for (const r of records.filter((x) => x.type === 'NS')) {
      const zone = normName(r.name)
      if ((n === zone || n.endsWith(`.${zone}`)) && (!best || zone.length > best.zone.length)) best = { node, zone, ns: normName(r.value), nsTtl: r.ttl }
    }
  }
  if (best) return best
  // No NS record: the zone is the last two labels, if a DNS server holds records under it
  const zone = n.split('.').slice(-2).join('.')
  const node = ctx.nodes.find((x) => x.data.deviceType === 'dns' && x.data.ip && (x.data.dnsRecords ?? []).some((r) => normName(r.name) === zone || normName(r.name).endsWith(`.${zone}`)))
  return node ? { node, zone, ns: `ns.${zone}`, nsTtl: 3600 } : null
}

const nsRecord = (name: string, value: string, ttl: number): AnswerRecord => ({ name, type: 'NS', value, ttl })

function digTrace(name: string, qtype: DnsRecordType, ctx: TermContext, banner: Lines): Lines {
  const n = normName(name)
  const tld = n.split('.').pop() ?? ''
  const fail = (explain: string): Lines => [err(';; connection timed out; no servers could be reached'), info(explain)]

  // 1. The root servers' names, from this device's resolver
  const root = lookupName('.', 'NS', ctx, { useCache: false })
  if (root.kind === 'no-dns') return [...banner, ...fail(root.explain)]
  if (root.kind === 'timeout') return [...banner, ...playLookup({ name: '.', timeout: root.timeout }, ctx, fail(root.explain)).lines]
  if (root.kind !== 'answer') return banner
  const rootNs: AnswerRecord[] = ROOT_SERVERS.map((s) => nsRecord('', s, ROOT_NS_TTL))
  const resolverIp = root.query.serverIp

  const legs: Leg[] = []
  const step = (server: NetNode, serverIp: string, path: string[], qname: string, qt: DnsRecordType, answer: DnsAnswer, lines: Lines) => {
    const steps = dnsSteps(newTransactionId(), qname, qt, answer)
    steps[1]!.lines = lines
    legs.push({ conv: newConversation(ctx.selfId, server.id, serverIp, 53, steps), path })
  }
  const received = (records: AnswerRecord[], qname: string, ip: string, label: string, ms: number) =>
    out(`;; Received ${messageSize(qname, records)} bytes from ${ip}#53(${label}) in ${ms} ms`)
  const block = (records: AnswerRecord[], tail: TerminalLine): Lines => [...records.map((r) => out(digLine(r))), tail, out('')]

  step(root.query.server, resolverIp, root.query.path, '.', 'NS', { status: 'NOERROR', records: rootNs, authoritative: false },
    [...banner, ...block(rootNs, received(rootNs, '.', resolverIp, resolverIp, queryTimeMs(root.query.path, ctx)))])

  // 2–3. The root and the top-level-domain servers are on the internet
  const cloud = ctx.nodes.find((x) => x.data.deviceType === 'cloud' && x.data.isOn !== false)
  const toInternet = cloud ? routeTo(cloud, ROOT_A_IP, ctx, { protocol: 'UDP', port: 53 }) : null
  const auth = authorityFor(n, ctx)
  const isPublic = !auth && !!PUBLIC_IPS[n]
  const simulated = tld === 'example'
    ? 'ⓘ Networx pretends .example is a real top-level domain so you can see every step. A real domain such as nsw.gov.au goes root → .au → gov.au → nsw.gov.au.'
    : `ⓘ The .${tld} step is simulated, with a made-up server name (${tldServer(tld).name}). A real domain such as nsw.gov.au goes root → .au → gov.au → nsw.gov.au.`
  const resolverNote = 'ⓘ dig +trace makes each query itself so you can see every step. Normally your device asks one server (its resolver), which does these steps for you and caches each answer.'
  if (!cloud || !toInternet || !toInternet.ok) {
    const why = toInternet && !toInternet.ok ? toInternet.explain : 'ⓘ This device has no route to the internet, where the root servers are.'
    const run1 = runConversations(legs, ctx)
    return [...run1.lines, ...delayLines(fail(why), run1.endMs)]
  }
  const net = toInternet.path
  const rand = (base: number) => base + Math.floor(Math.random() * 6)

  if (!auth && !isPublic) {
    // The root has no such top-level domain (or the zone is only on this network): no such name
    const nx: DnsAnswer = { status: 'NXDOMAIN', records: [], authoritative: true }
    step(cloud, ROOT_A_IP, net, n, qtype, nx, [received([], n, ROOT_A_IP, ROOT_SERVERS[0]!, rand(18)), out(''),
      info(`ⓘ NXDOMAIN from the root: no top-level domain or zone on the internet holds ${n}. (A name that only exists inside a network, like .local, can't be traced from the root.)`), info(resolverNote)])
    return runConversations(legs, ctx).lines
  }

  const tldSrv = tldServer(tld)
  const tldNs = [nsRecord(tld, tldSrv.name, TLD_NS_TTL)]
  step(cloud, ROOT_A_IP, net, n, qtype, { status: 'NOERROR', records: tldNs, authoritative: false },
    block(tldNs, received(tldNs, n, ROOT_A_IP, ROOT_SERVERS[0]!, rand(18))))

  if (isPublic) {
    // A well-known internet name: the (simulated) top-level-domain server gives the answer
    const answer = serverAnswer(cloud, n, qtype, ctx)
    step(cloud, tldSrv.ip, net, n, qtype, { ...answer, authoritative: true },
      [...block(answer.records, received(answer.records, n, tldSrv.ip, tldSrv.name, rand(15))), info(simulated), info(resolverNote)])
    return runConversations(legs, ctx).lines
  }

  // 3. The TLD server refers to the domain's name server
  const domainNs = [nsRecord(auth!.zone, auth!.ns, auth!.nsTtl)]
  step(cloud, tldSrv.ip, net, n, qtype, { status: 'NOERROR', records: domainNs, authoritative: false },
    block(domainNs, received(domainNs, n, tldSrv.ip, tldSrv.name, rand(15))))

  // 4. The domain's own DNS server answers (authoritative)
  const authIp = auth!.node.data.ip
  const toAuth = routeTo(auth!.node, authIp, ctx, { protocol: 'UDP', port: 53 })
  if (!toAuth.ok || auth!.node.data.isOn === false) {
    const run1 = runConversations(legs, ctx)
    const why = !toAuth.ok ? toAuth.explain : `ⓘ ${auth!.node.data.label} (${authIp}) didn't answer.`
    return [...run1.lines, ...delayLines(fail(why), run1.endMs)]
  }
  const answer = serverAnswer(auth!.node, n, qtype, ctx)
  const tail = answer.status === 'NXDOMAIN'
    ? [info(`ⓘ NXDOMAIN: ${auth!.ns} holds ${auth!.zone}'s records and has none for ${n}.`)]
    : []
  step(auth!.node, authIp, toAuth.path, n, qtype, answer,
    [...block(answer.records, received(answer.records, n, authIp, auth!.ns, queryTimeMs(toAuth.path, ctx))), ...tail, info(simulated), info(resolverNote)])
  return runConversations(legs, ctx).lines
}
