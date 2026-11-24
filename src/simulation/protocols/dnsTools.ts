import type { DnsRecordType, TerminalLine } from '../../types'
import { type TermContext, type Lines, out, err, info, delayLines } from '../context'
import { lookupName, isIp, resolveTarget, isResolveError, dnsServerIpOf, type DnsLookup } from '../resolve'
import { playLookup } from '../lookup'
import { RECORD_TYPES, digLine, fqdn, rdata, messageSize, normName, type DnsAnswer, type AnswerRecord } from '../dns'
import { nodeById } from '../network'
import { cacheEntries, flushDnsCache } from '../dnsCache'

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

/** Plain-language notes after an answer: one per record type, the TTLs, and what the flags mean. */
export function answerNotes(name: string, qtype: DnsRecordType, answer: DnsAnswer, cached = false): string[] {
  const notes: string[] = []
  const fromCache = 'ⓘ Answered from this device\'s cache — nothing was sent. It stays cached until the TTL runs out.'
  if (answer.status === 'NXDOMAIN') return [`ⓘ NXDOMAIN: no such name — the DNS server has no records for ${normName(name)}.`, ...(cached ? [fromCache] : [])]
  if (answer.status === 'SERVFAIL') return ["ⓘ SERVFAIL: the server couldn't answer — the CNAME records go round in a loop, or the chain is too long."]
  if (!answer.records.length) return [`ⓘ NOERROR but no answer: ${normName(name)} exists, but has no ${qtype} record.`, ...(cached ? [fromCache] : [])]
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
    : 'ⓘ No aa flag: this server looked the answer up elsewhere for you, so it is not authoritative.')
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

export function cmdDig(args: string[], ctx: TermContext): Lines {
  const flags = args.filter((a) => a.startsWith('+'))
  const at = args.find((a) => a.startsWith('@'))
  const rest = args.filter((a) => !a.startsWith('+') && !a.startsWith('@'))
  const short = flags.includes('+short')
  if (flags.includes('+trace')) return []   // B5
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
  const looked = lookupName(name, qtype, ctx, { serverIp })
  if (looked.kind === 'cached') return digAnswer(name, qtype, looked, { short, banner, ctx })
  if (looked.kind !== 'answer') {
    const fail = [err(';; connection timed out; no servers could be reached'), info(looked.explain)]
    if (looked.kind === 'no-dns') return [...(short ? [] : banner), ...fail]
    return [...(short ? [] : banner), ...playLookup({ name, timeout: looked.timeout }, ctx, fail).lines]
  }
  return playLookup({ name, query: looked.query }, ctx, digAnswer(name, qtype, looked, { short, banner, ctx })).lines
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
    out(`;; Query time: ${cached ? 0 : queryTimeMs(looked.query.path, o.ctx)} msec`),
    out(`;; SERVER: ${serverIp}#53(${serverIp})`),
    out(`;; WHEN: ${digWhen()}`),
    out(`;; MSG SIZE  rcvd: ${messageSize(name, records)}`),
    out(''),
    ...answerNotes(name, qtype, answer, cached).map((t) => info(t)),
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
  if (looked.kind === 'timeout') return playLookup({ name: domain, timeout: looked.timeout }, ctx, timedOut(looked.explain)).lines

  const { answer, query } = looked
  const lines: Lines = [out(`Server:   ${query.serverIp}`), out(`Address:  ${query.serverIp}#53`), out('')]
  if (answer.status === 'NXDOMAIN') lines.push(out(`** server can't find ${domain}: NXDOMAIN`))
  else if (answer.status === 'SERVFAIL') lines.push(out(`** server can't find ${domain}: SERVFAIL`))
  else if (!answer.records.length) lines.push(out(`*** Can't find ${domain}: No answer`))
  else {
    if (!answer.authoritative) lines.push(out('Non-authoritative answer:'))
    for (const r of answer.records) lines.push(...nslookupLine(r))
  }
  const end = playLookup({ name: domain, query }, ctx).endMs
  return delayLines(lines, end)
}


// ── The device's DNS cache ──────────────────────────────────────────────────

export function cmdDnsCache(ctx: TermContext): Lines {
  const me = nodeById(ctx.selfId, ctx.nodes)
  const entries = cacheEntries(ctx.selfId)
  if (!entries.length) return [out(`The DNS cache on ${me?.data.label ?? 'this device'} is empty.`)]
  const lines: Lines = [
    out(`DNS cache on ${me?.data.label ?? 'this device'}:`),
    out(`${'Name'.padEnd(30)}${'Type'.padEnd(7)}${'TTL left'.padEnd(10)}Answer`),
  ]
  for (const e of entries) {
    const shown = e.answer.status !== 'NOERROR' ? e.answer.status
      : e.answer.records.length ? e.answer.records.map((r) => (r.type === e.qtype ? rdata(r) : `${rdata(r)} (${r.type})`)).join(', ')
      : 'no record of this type'
    lines.push(out(`${e.name.padEnd(30)}${e.qtype.padEnd(7)}${`${e.remaining} s`.padEnd(10)}${shown}`))
  }
  lines.push(info('ⓘ Each answer is kept until its TTL runs out, then the device asks its DNS server again. flushdns empties the cache.'))
  return lines
}

export function cmdFlushDns(ctx: TermContext, quiet = false): Lines {
  flushDnsCache(ctx.selfId)
  if (quiet) return []
  const me = nodeById(ctx.selfId, ctx.nodes)
  return [info(`Flushed the DNS cache on ${me?.data.label ?? 'this device'}. The next lookup asks the DNS server again.`)]
}
