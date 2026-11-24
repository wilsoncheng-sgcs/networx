import type { PacketAnim, PendingCapture, TerminalLine } from '../types'
import type { TermContext } from './context'
import { nodeById } from './network'
import { HOP_MS, scaledHop, leg, firstHopMacs, nextBatchId } from './packets'
import { CONV_HOP_MS, ephemeralPort } from './exchange'
import type { Route } from './routing'

type Failed = Extract<Route, { ok: false }>

export type Attempt =
  | { kind: 'tcp'; port: number }
  | { kind: 'icmp' }

/**
 * Play what a failed connection looks like on the wire, then print `lines`:
 * - no usable gateway: nothing leaves the device;
 * - ARP got no answer: three ARP requests (broadcast), no reply;
 * - dropped on the way, or no reply: the requests travel as far as they get, and nothing comes back
 *   (TCP sends its SYN three times; ping sends four echo requests).
 */
export function playUnreachable(
  route: Failed,
  attempt: Attempt,
  dstIp: string,
  ctx: TermContext,
  lines: TerminalLine[],
  startMs = 0,
): { lines: TerminalLine[]; endMs: number } {
  const src = nodeById(ctx.selfId, ctx.nodes)
  const at = (t: number) => lines.map((l) => ({ ...l, delayMs: t + (l.delayMs ?? 0) }))
  if (!src) return { lines: at(startMs), endMs: startMs }
  const convId = `drop-${nextBatchId()}`
  const packets: PacketAnim[] = []
  const captures: PendingCapture[] = []

  if (route.failure === 'host-unreachable' && route.arpFor) {
    // ARP asks the whole segment; nobody answers
    const neighbour = ctx.edges.find((e) => e.source === src.id || e.target === src.id)
    const routeIds = neighbour ? [src.id, neighbour.source === src.id ? neighbour.target : neighbour.source] : [src.id]
    const gap = Math.max(scaledHop(HOP_MS) * 2, 1)
    for (let i = 0; i < 3; i++) {
      if (neighbour) packets.push(...leg(routeIds, ctx.edges, 'ARP', 'who has?', startMs + i * gap))
      captures.push({
        delayMs: startMs + i * gap, conversationId: convId, stepIndex: i, route: routeIds,
        srcIp: src.data.ip, dstIp: route.arpFor, srcMac: src.data.mac, dstMac: 'ff:ff:ff:ff:ff:ff',
        transport: 'ARP', app: 'ARP', encrypted: false, length: 28,
        info: `Who has ${route.arpFor}? Tell ${src.data.ip}`,
      })
    }
    const end = startMs + 3 * gap
    ctx.dispatchPackets?.(packets)
    ctx.dispatchCaptures?.(captures)
    return { lines: at(end), endMs: end }
  }

  if ((route.failure === 'private' || route.failure === 'no-reply') && route.reach && route.reach.length > 1) {
    const hop = scaledHop(CONV_HOP_MS)
    const legMs = (route.reach.length - 1) * hop
    const macs = firstHopMacs(route.reach, ctx.nodes)
    const tries = attempt.kind === 'tcp' ? 3 : 4
    const clientPort = ephemeralPort()
    let t = startMs
    for (let i = 0; i < tries; i++) {
      const base = {
        delayMs: t, conversationId: convId, stepIndex: i, route: route.reach,
        srcIp: src.data.ip, dstIp, ...macs, encrypted: false,
      }
      if (attempt.kind === 'tcp') {
        packets.push(...leg(route.reach, ctx.edges, 'TCP', i ? 'SYN (again)' : 'SYN', t, false, hop))
        captures.push({
          ...base, srcPort: clientPort, dstPort: attempt.port, transport: 'TCP', tcpFlags: 'SYN', app: null, length: 40,
          info: `${i ? '[TCP Retransmission] ' : ''}[SYN] Seq=0`,
        })
      } else {
        packets.push(...leg(route.reach, ctx.edges, 'ICMP', 'ICMP', t, false, hop))
        captures.push({
          ...base, transport: 'ICMP', app: 'ICMP', length: 84,
          info: `Echo (ping) request  id=0x0001, seq=${i}, ttl=64 (no response found!)`,
        })
      }
      t += legMs + Math.max(hop, 1)
    }
    const end = t + legMs
    ctx.dispatchPackets?.(packets)
    ctx.dispatchCaptures?.(captures)
    return { lines: at(end), endMs: end }
  }

  // Nothing leaves the device
  return { lines: at(startMs), endMs: startMs }
}
