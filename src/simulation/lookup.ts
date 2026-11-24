import type { TerminalLine } from '../types'
import type { TermContext } from './context'
import { isResolveError, type Resolution } from './resolve'
import { dnsConversation, runConversations } from './exchange'
import { playUnreachable } from './unreachable'

/**
 * Play what a name lookup puts on the wire, then print `lines`:
 * the query and its answer; or, when the DNS server never answers, the query three times and nothing back;
 * or nothing at all (an IP address needs no lookup). Returns the timed lines and when the lookup ends.
 */
export function playLookup(r: Resolution, ctx: TermContext, lines: TerminalLine[] = [], startMs = 0): { lines: TerminalLine[]; endMs: number } {
  const leg = dnsConversation(r, ctx, lines)
  if (leg) return runConversations([leg], ctx, startMs)
  if (isResolveError(r) && r.timeout) {
    return playUnreachable(r.timeout.route, { kind: 'dns', name: r.name }, r.timeout.serverIp, ctx, lines, startMs)
  }
  return { lines: lines.map((l) => ({ ...l, delayMs: startMs + (l.delayMs ?? 0) })), endMs: startMs }
}
