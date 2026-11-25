import type { TerminalLine } from '../types'
import type { TermContext } from './context'
import { FORWARD_TIMEOUT_MS, type DnsQuery, type DnsTimeout } from './resolve'
import { dnsSteps, newConversation, runConversations, type Leg } from './exchange'
import { playUnreachable } from './unreachable'
import { scaledHop } from './packets'
import { holdUntilArrival, serverCacheId } from './dnsCache'

type LookupResult = { name: string; query?: DnsQuery; timeout?: DnsTimeout; failedFirst?: DnsTimeout[] }

/** Play the queries to DNS servers that never answered (before the alternate is asked); returns when they gave up. */
export function playFailedServers(r: LookupResult, ctx: TermContext, startMs = 0): number {
  let t = startMs
  for (const f of r.failedFirst ?? []) t = playUnreachable(f.route, { kind: 'dns', name: r.name, qtype: f.qtype }, f.serverIp, ctx, [], t).endMs
  return t
}

/** A leg that sends nothing: the answer cached under `cacheId` shows in the side panel when its packet arrives. */
function arrivalLeg(cacheId: string, name: string, q: DnsQuery, ctx: TermContext): Leg {
  const release = holdUntilArrival(cacheId, name, q.qtype)
  return { play: (t: number) => {
    if (ctx.schedule) ctx.schedule(t, release)
    else release()
    return { lines: [], endMs: t }
  } }
}

/**
 * The legs one DNS query puts on the wire, sent by `clientId`: the query, then — when the server doesn't
 * hold the name — its own query to its forwarder and the reply (or, when the forwarder never answers,
 * one query and the wait), then the answer, which prints `lines`. The answer is cached under `cacheId`
 * (the device's own cache, or a DNS server's cache of what its forwarder told it).
 */
function queryLegs(q: DnsQuery, name: string, clientId: string, cacheId: string, ctx: TermContext, lines?: TerminalLine[]): Leg[] {
  const steps = dnsSteps(q.id, name, q.qtype, q.answer)
  if (lines) steps[1]!.lines = lines
  const conv = newConversation(clientId, q.server.id, q.serverIp, 53, steps)
  const arrived = arrivalLeg(cacheId, name, q, ctx)
  const f = q.forwarded
  if (!f) return [{ conv, path: q.path }, arrived]
  const fromServer: TermContext = { ...ctx, selfId: q.server.id }
  const upstream: Leg[] = f.query
    ? queryLegs(f.query, f.name, q.server.id, serverCacheId(q.server.id), ctx)
    : f.timeout
      ? [{ play: (t: number) => {
          // The server waits for its forwarder even when its query can't leave (no connection at all)
          const p = playUnreachable(f.timeout!.route, { kind: 'dns', name: f.name, qtype: f.qtype, tries: 1, waitMs: FORWARD_TIMEOUT_MS }, f.forwarderIp, fromServer, [], t)
          return { ...p, endMs: Math.max(p.endMs, t + scaledHop(FORWARD_TIMEOUT_MS)) }
        } }]
      : []
  return [{ conv, path: q.path, steps: [0, 1] }, ...upstream, { conv, path: q.path, steps: [1, 2] }, arrived]
}

/** The DNS legs for a resolution — played whenever a DNS server answered, even for NXDOMAIN. Empty when nothing was sent. */
export function dnsLegs(r: { name: string; query?: DnsQuery }, ctx: TermContext, lines?: TerminalLine[]): Leg[] {
  return r.query ? queryLegs(r.query, r.name, ctx.selfId, ctx.selfId, ctx, lines) : []
}

/** The first leg waits `waitMs` (for DNS servers that never answered). */
export function withWait(legs: Leg[], waitMs: number): Leg[] {
  return legs.map((l, i) => (i === 0 ? { ...l, waitMs } : l))
}

/**
 * Play what a name lookup puts on the wire, then print `lines`:
 * the query and its answer (with the server's query to its forwarder in between, if it asked one); or,
 * when the DNS server never answers, the query three times and nothing back (then the same to the
 * alternate DNS server, if there is one); or nothing at all (an IP address, or an answer from the
 * device's cache). Returns the timed lines and when the lookup ends.
 */
export function playLookup(r: LookupResult, ctx: TermContext, lines: TerminalLine[] = [], startMs = 0): { lines: TerminalLine[]; endMs: number } {
  const t = playFailedServers(r, ctx, startMs)
  const legs = dnsLegs(r, ctx, lines)
  if (legs.length) return runConversations(legs, ctx, t)
  if (r.timeout) {
    return playUnreachable(r.timeout.route, { kind: 'dns', name: r.name, qtype: r.timeout.qtype }, r.timeout.serverIp, ctx, lines, t)
  }
  return { lines: lines.map((l) => ({ ...l, delayMs: t + (l.delayMs ?? 0) })), endMs: t }
}
