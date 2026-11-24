import type { DnsRecord, DnsRecordType } from '../types'

/**
 * DNS records, and how a server answers a query from them (Phase 4 B2).
 * Names are compared without case and without a trailing dot.
 */

export const RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']

export const RECORD_HELP: Record<DnsRecordType, string> = {
  A: 'Name → IPv4 address',
  AAAA: 'Name → IPv6 address',
  CNAME: 'This name is an alias: look up the other name instead',
  MX: 'Where email for this domain is delivered (lowest priority number first)',
  NS: 'Which name server holds this domain\'s records (is authoritative)',
  TXT: 'Free text, e.g. email anti-spoofing (SPF) or proof you own the domain',
}

export const DEFAULT_TTL = 3600
/** TTL Networx gives the well-known internet names it answers. */
export const PUBLIC_TTL = 300
/** How long a "no such name" answer may be cached (negative caching). */
export const NEGATIVE_TTL = 60
export const MAX_TTL = 86400
const MAX_CNAME_LINKS = 8

export function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/** A name with its trailing dot, as dig prints it. */
export function fqdn(name: string): string {
  const n = name.trim().replace(/\.$/, '')
  return n ? `${n}.` : '.'
}

/** A record saved by an older version (`{ hostname, ip }`) becomes an A record. */
export function normaliseRecord(raw: Partial<DnsRecord> & { hostname?: string; ip?: string }): DnsRecord {
  const name = raw.name ?? raw.hostname ?? ''
  const type = raw.type && RECORD_TYPES.includes(raw.type) ? raw.type : 'A'
  const value = raw.value ?? raw.ip ?? ''
  const ttl = typeof raw.ttl === 'number' && Number.isFinite(raw.ttl) ? raw.ttl : DEFAULT_TTL
  const rec: DnsRecord = { id: raw.id ?? `dr${Math.random().toString(36).slice(2, 8)}`, name, type, value, ttl }
  if (type === 'MX') rec.priority = typeof raw.priority === 'number' ? raw.priority : 10
  return rec
}

// ── Validation ───────────────────────────────────────────────────────────────

export function isIpv4(s: string): boolean {
  const parts = s.trim().split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function isIpv6(s: string): boolean {
  const v = s.trim()
  if (!/^[0-9a-fA-F:]+$/.test(v) || v.includes(':::')) return false
  const halves = v.split('::')
  if (halves.length > 2) return false
  const groups = (h: string) => (h === '' ? [] : h.split(':'))
  const all = halves.flatMap(groups)
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false
  return halves.length === 2 ? all.length < 8 : all.length === 8
}

export function isHostname(s: string): boolean {
  const n = s.trim().replace(/\.$/, '')
  if (!n || n.length > 253) return false
  return n.split('.').every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
}

/** Why `rec` can't be saved alongside `others` (the server's other records), or null when it can. */
export function validateRecord(rec: DnsRecord, others: DnsRecord[]): string | null {
  if (!isHostname(rec.name)) return 'Name must be a host name, e.g. portal.careconnect.example'
  const value = rec.value.trim()
  switch (rec.type) {
    case 'A': if (!isIpv4(value)) return 'An A record needs an IPv4 address, e.g. 203.0.113.80'; break
    case 'AAAA': if (!isIpv6(value)) return 'An AAAA record needs an IPv6 address, e.g. 2001:db8::80'; break
    case 'CNAME':
    case 'MX':
    case 'NS': if (!isHostname(value)) return `A${rec.type === 'MX' ? 'n' : ''} ${rec.type} record needs a host name, e.g. mail.careconnect.example`; break
    case 'TXT': if (!value) return 'A TXT record needs some text'; break
  }
  if (!Number.isInteger(rec.ttl) || rec.ttl < 0 || rec.ttl > MAX_TTL) return `TTL must be a whole number of seconds from 0 to ${MAX_TTL}`
  if (rec.type === 'MX' && (!Number.isInteger(rec.priority) || rec.priority! < 0 || rec.priority! > 65535)) return 'Priority must be a whole number from 0 to 65535'
  const sameName = others.filter((o) => o.id !== rec.id && normName(o.name) === normName(rec.name))
  if (rec.type === 'CNAME' && sameName.length) return `${rec.name} already has other records: a CNAME can't share its name with any other record`
  if (rec.type !== 'CNAME' && sameName.some((o) => o.type === 'CNAME')) return `${rec.name} is an alias (CNAME): it can't have other records`
  if (sameName.some((o) => o.type === rec.type && o.value.trim().toLowerCase() === value.toLowerCase())) return 'That record already exists'
  return null
}

// ── Answering a query ────────────────────────────────────────────────────────

export type DnsStatus = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL'

/** One record in an answer: the record as the server holds it (TTL may be lowered by a cache). */
export interface AnswerRecord {
  name: string
  type: DnsRecordType
  value: string
  ttl: number
  priority?: number
}

export interface DnsAnswer {
  status: DnsStatus
  records: AnswerRecord[]
  /** The server holds the records for the name asked (dig's `aa` flag). */
  authoritative: boolean
}

/**
 * Answer a query from `zone` (the records this server holds, authoritative) and, for names it doesn't
 * hold, `elsewhere` (records it can look up for you: non-authoritative). Follows CNAME chains.
 */
export function answerQuery(
  zone: DnsRecord[],
  elsewhere: (name: string) => AnswerRecord[],
  name: string,
  qtype: DnsRecordType,
): DnsAnswer {
  const records: AnswerRecord[] = []
  const seen = new Set<string>()
  let cur = normName(name)
  const authoritative = zone.some((r) => normName(r.name) === cur)
  for (let link = 0; link <= MAX_CNAME_LINKS; link++) {
    if (seen.has(cur)) return { status: 'SERVFAIL', records: [], authoritative: false }  // a CNAME loop
    seen.add(cur)
    const own = zone.filter((r) => normName(r.name) === cur)
    const held: AnswerRecord[] = own.length
      ? own.map((r) => ({ name: normName(r.name), type: r.type, value: r.value.trim(), ttl: r.ttl, ...(r.type === 'MX' ? { priority: r.priority ?? 10 } : {}) }))
      : elsewhere(cur)
    if (!held.length) return { status: 'NXDOMAIN', records, authoritative }
    const match = held.filter((r) => r.type === qtype)
    if (match.length) return { status: 'NOERROR', records: [...records, ...sortAnswer(match)], authoritative }
    const cname = held.find((r) => r.type === 'CNAME')
    if (!cname) return { status: 'NOERROR', records, authoritative }   // the name exists, but has no record of this type
    records.push(cname)
    cur = normName(cname.value)
  }
  return { status: 'SERVFAIL', records: [], authoritative: false }      // the chain is too long
}

function sortAnswer(records: AnswerRecord[]): AnswerRecord[] {
  return [...records].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
}

/** The IPv4 address an answer ends at (the last A record), if any. */
export function addressOf(answer: DnsAnswer): string | null {
  return [...answer.records].reverse().find((r) => r.type === 'A')?.value ?? null
}

// ── How answers look ─────────────────────────────────────────────────────────

/** The record's data as dig prints it. */
export function rdata(r: AnswerRecord): string {
  switch (r.type) {
    case 'CNAME':
    case 'NS': return fqdn(r.value)
    case 'MX': return `${r.priority ?? 10} ${fqdn(r.value)}`
    case 'TXT': return r.value.startsWith('"') ? r.value : `"${r.value}"`
    default: return r.value
  }
}

/** A dig answer line: name, TTL, class, type, data. */
export function digLine(r: AnswerRecord): string {
  const name = fqdn(r.name)
  return `${name.length < 24 ? name.padEnd(24) : `${name} `}${r.ttl}\tIN\t${r.type}\t${rdata(r)}`
}

/** A new 16-bit DNS transaction id, as Wireshark shows it (0x1a2b). */
export function newTransactionId(rand: () => number = Math.random): string {
  return `0x${Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')}`
}

/** The capture Info for a query: `Standard query 0x1a2b A www.careconnect.example`. */
export function queryInfo(id: string, qtype: DnsRecordType, name: string): string {
  return `Standard query ${id} ${qtype} ${normName(name)}`
}

/** The capture Info for a response, Wireshark style: the answers after the question. */
export function responseInfo(id: string, qtype: DnsRecordType, name: string, answer: DnsAnswer): string {
  const q = `${qtype} ${normName(name)}`
  if (answer.status === 'NXDOMAIN') return `Standard query response ${id} No such name ${q}`
  if (answer.status === 'SERVFAIL') return `Standard query response ${id} Server failure ${q}`
  const parts = answer.records.map((r) => (r.type === 'TXT' ? 'TXT' : `${r.type} ${rdata(r).replace(/\.$/, '')}`))
  return `Standard query response ${id} ${q}${parts.length ? ` ${parts.join(' ')}` : ''}`
}

/** What is on the wire for a response (the detail pane). */
export function responsePayload(qtype: DnsRecordType, name: string, answer: DnsAnswer): string {
  const head = `Reply code: ${answer.status === 'NOERROR' ? 'No error' : answer.status === 'NXDOMAIN' ? 'No such name (NXDOMAIN)' : 'Server failure (SERVFAIL)'}`
  const flags = `Authoritative: ${answer.authoritative ? 'yes (this server holds the records)' : 'no'}`
  const q = `Query: ${normName(name)}, type ${qtype}, class IN`
  if (!answer.records.length) return [head, flags, q, 'Answers: none'].join('\n')
  const lines = answer.records.map((r) => `  ${r.name}: type ${r.type}, class IN, ${r.type === 'A' || r.type === 'AAAA' ? 'addr' : 'data'} ${rdata(r)}, TTL ${r.ttl}`)
  return [head, flags, q, 'Answers:', ...lines].join('\n')
}

/** Bytes a name takes on the wire, reusing (compressing) a suffix already written. */
function nameBytes(name: string, written: string[]): number {
  const labels = normName(name).split('.').filter(Boolean)
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.')
    if (written.includes(suffix)) {
      written.push(...labels.slice(0, i).map((_, j) => labels.slice(j).join('.')))
      return labels.slice(0, i).reduce((n, l) => n + l.length + 1, 0) + 2
    }
  }
  written.push(...labels.map((_, j) => labels.slice(j).join('.')))
  return labels.reduce((n, l) => n + l.length + 1, 0) + 1
}

/**
 * The size of a DNS message (header, question, answers, and an EDNS OPT record), with name compression,
 * for dig's MSG SIZE and the capture's Length.
 */
export function messageSize(name: string, records: AnswerRecord[], withOpt = true): number {
  const written: string[] = []
  let size = 12 + nameBytes(name, written) + 4
  for (const r of records) {
    size += nameBytes(r.name, written) + 10
    switch (r.type) {
      case 'A': size += 4; break
      case 'AAAA': size += 16; break
      case 'MX': size += 2 + nameBytes(r.value, written); break
      case 'CNAME':
      case 'NS': size += nameBytes(r.value, written); break
      case 'TXT': size += rdata(r).replace(/^"|"$/g, '').length + 1; break
    }
  }
  return size + (withOpt ? 11 : 0)
}
