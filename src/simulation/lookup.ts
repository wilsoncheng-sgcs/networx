import type { TerminalLine } from '../types'
import type { TermContext } from './context'
import type { DnsQuery, DnsTimeout } from './resolve'
import { dnsConversation, runConversations } from './exchange'
import { playUnreachable } from './unreachable'

type LookupResult = { name: string; query?: DnsQuery; timeout?: DnsTimeout; failedFirst?: DnsTimeout[] }

/** Play the queries to DNS servers that never answered (before the alternate is asked); returns when they gave up. */
export function playFailedServers(r: LookupResult, ctx: TermContext, startMs = 0): number {
  let t = startMs
  for (const f of r.failedFirst ?? []) t = playUnreachable(f.route, { kind: 'dns', name: r.name, qtype: f.qtype }, f.serverIp, ctx, [], t).endMs
  return t
}

/**
 * Play what a name lookup puts on the wire, then print `lines`:
 * the query and its answer; or, when the DNS server never answers, the query three times and nothing back
 * (then the same to the alternate DNS server, if there is one); or nothing at all (an IP address, or an
 * answer from the device's cache). Returns the timed lines and when the lookup ends.
 */
export function playLookup(r: LookupResult, ctx: TermContext, lines: TerminalLine[] = [], startMs = 0): { lines: TerminalLine[]; endMs: number } {
  const t = playFailedServers(r, ctx, startMs)
  const leg = dnsConversation(r, ctx, lines)
  if (leg) return runConversations([leg], ctx, t)
  if (r.timeout) {
    return playUnreachable(r.timeout.route, { kind: 'dns', name: r.name, qtype: r.timeout.qtype }, r.timeout.serverIp, ctx, lines, t)
  }
  return { lines: lines.map((l) => ({ ...l, delayMs: t + (l.delayMs ?? 0) })), endMs: t }
}
