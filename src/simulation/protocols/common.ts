import type { NetNode, TerminalLine } from '../../types'
import type { TermContext, Lines } from '../context'
import { resolveTarget, isResolveError, routeTo, type Resolved } from '../resolve'
import { errnoText } from '../routing'
import { playUnreachable } from '../unreachable'
import { playLookup } from '../lookup'
import { info } from '../context'
import { isListening, serviceById, type ServiceId } from '../services'
import { type Leg, type Step, dnsConversation, newConversation, tcpRefused, runConversations } from '../exchange'

export interface Target {
  r: Resolved
  server: NetNode
  path: string[]
  /** The DNS Conversation, if a DNS server was asked: play it first. */
  legs: Leg[]
}

export interface Failure {
  lines: TerminalLine[]
}

/**
 * Resolve `host` and find a path to it (spec §2.5). On failure the DNS Conversation (if any)
 * is played with the error lines, and the timed lines are returned.
 */
export function connectTo(
  host: string,
  port: number,
  ctx: TermContext,
  messages: { unresolved: Lines; noRoute: (why: string) => Lines },
): Target | Failure {
  const r = resolveTarget(host, ctx)
  if (isResolveError(r)) {
    const lines = [
      ...(r.error === 'no-route' ? messages.noRoute('No route to host') : messages.unresolved),
      ...(r.explain ? [info(r.explain)] : []),
    ]
    return { lines: playLookup(r, ctx, lines).lines }
  }
  const dnsLeg = dnsConversation(r, ctx)
  const route = routeTo(r.node, r.ip, ctx, { protocol: 'TCP', port })
  if (!route.ok || !r.node) {
    // Subnet, gateway or private-address rules stop it: show how far the SYN gets, then why
    const why = route.ok ? 'No route to host' : errnoText(route.failure)
    const lines = [...messages.noRoute(why), ...(!route.ok && route.explain ? [info(route.explain)] : [])]
    const dns = runConversations(dnsLeg ? [dnsLeg] : [], ctx)
    if (route.ok) return { lines: [...dns.lines, ...lines.map((l) => ({ ...l, delayMs: dns.endMs }))] }
    return { lines: [...dns.lines, ...playUnreachable(route, { kind: 'tcp', port }, r.ip, ctx, lines, dns.endMs).lines] }
  }
  return { r, server: r.node, path: route.path, legs: dnsLeg ? [dnsLeg] : [] }
}

export function isFailure(t: Target | Failure): t is Failure {
  return !('server' in t)
}

/** Is the service up on this target? (Internet hosts answer HTTP and HTTPS only.) */
export function serviceUp(t: Target, id: ServiceId): boolean {
  return isListening(t.server, id)
}

/** Nothing listening: DNS, then SYN → RST, then the refusal lines. */
export function refuse(t: Target, port: number, ctx: TermContext, lines: Lines): Lines {
  const steps = tcpRefused()
  steps[1]!.lines = lines
  const run = runConversations([...t.legs, { conv: newConversation(ctx.selfId, t.server.id, t.r.ip, port, steps), path: t.path }], ctx)
  return run.lines
}

/** Play DNS (if any) then the main Conversation; return the timed lines. */
export function play(t: Target, port: number, steps: Step[], ctx: TermContext, clientPort?: number): Lines {
  const conv = newConversation(ctx.selfId, t.server.id, t.r.ip, port, steps, clientPort)
  return runConversations([...t.legs, { conv, path: t.path }], ctx).lines
}

export function portOf(id: ServiceId): number {
  return serviceById(id).port
}

/** A request from the client: one TCP segment carrying application data. */
export function c2s(app: Step['app'], label: string, payload: string, info?: string, extra: Partial<Step> = {}): Step {
  return { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app, label: label.slice(0, 14), info: info ?? `Request: ${payload.split('\n')[0]}`, payload, ...extra }
}

/** A reply from the server. */
export function s2c(app: Step['app'], label: string, payload: string, info?: string, extra: Partial<Step> = {}): Step {
  return { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app, label: label.slice(0, 14), info: info ?? `Response: ${payload.split('\n')[0]}`, payload, ...extra }
}
