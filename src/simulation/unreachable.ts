import type { PacketAnim, PendingCapture, TerminalLine } from '../types'
import type { TermContext } from './context'
import { nodeById } from './network'
import { HOP_MS, scaledHop, leg, firstHopMacs, nextBatchId } from './packets'
import { CONV_HOP_MS, ephemeralPort } from './exchange'
import { travelsPartWay, type Route } from './routing'
import type { DnsRecordType } from '../types'
import { queryInfo, newTransactionId, messageSize } from './dns'

type Failed = Extract<Route, { ok: false }>

export type Attempt =
  | { kind: 'tcp'; port: number }
  | { kind: 'icmp' }
  /** A DNS query (UDP 53): the resolver sends it three times, about 5 s apart, then gives up. */
  | { kind: 'dns'; name: string; qtype?: DnsRecordType; id?: string }

/** How long a resolver waits for a DNS answer before sending the query again (simulation clock, Normal speed). */
export const DNS_RETRY_MS = 5000

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

  const travels = travelsPartWay(route.failure)
  // A firewall's drop, or the ISP's (no route), is marked with a red ✕ where the packet stops
  const drop = (pkts: PacketAnim[]) => ((route.failure === 'blocked' || route.failure === 'no-route') && pkts.length ? [...pkts.slice(0, -1), { ...pkts[pkts.length - 1]!, dropped: true }] : pkts)
  if (travels && route.reach && route.reach.length > 1) {
    const hop = scaledHop(CONV_HOP_MS)
    const legMs = (route.reach.length - 1) * hop
    const macs = firstHopMacs(route.reach, ctx.nodes)
    const tries = attempt.kind === 'icmp' ? 4 : 3
    const clientPort = ephemeralPort()
    const dnsId = attempt.kind === 'dns' ? attempt.id ?? newTransactionId() : ''
    // A resolver waits about 5 s for each answer; TCP and ping retry as soon as the last one has gone
    const gap = attempt.kind === 'dns' ? Math.max(scaledHop(DNS_RETRY_MS), legMs + hop) : legMs + Math.max(hop, 1)
    let t = startMs
    for (let i = 0; i < tries; i++) {
      const base = {
        delayMs: t, conversationId: convId, stepIndex: i, route: route.reach,
        srcIp: src.data.ip, dstIp, ...macs, encrypted: false,
      }
      if (attempt.kind === 'dns') {
        packets.push(...drop(leg(route.reach, ctx.edges, 'DNS', i ? 'DNS (again)' : 'DNS query', t, false, hop)))
        captures.push({
          ...base, srcPort: clientPort, dstPort: 53, transport: 'UDP', app: 'DNS', length: 20 + 8 + messageSize(attempt.name, []),
          info: queryInfo(dnsId, attempt.qtype ?? 'A', attempt.name), payload: `Query: ${attempt.name}, type ${attempt.qtype ?? 'A'}, class IN`,
        })
      } else if (attempt.kind === 'tcp') {
        packets.push(...drop(leg(route.reach, ctx.edges, 'TCP', i ? 'SYN (again)' : 'SYN', t, false, hop)))
        captures.push({
          ...base, srcPort: clientPort, dstPort: attempt.port, transport: 'TCP', tcpFlags: 'SYN', app: null, length: 40,
          info: `${i ? '[TCP Retransmission] ' : ''}[SYN] Seq=0`,
        })
      } else {
        packets.push(...drop(leg(route.reach, ctx.edges, 'ICMP', 'ICMP', t, false, hop)))
        captures.push({
          ...base, transport: 'ICMP', app: 'ICMP', length: 84,
          info: `Echo (ping) request  id=0x0001, seq=${i}, ttl=64 (no response found!)`,
        })
      }
      t += gap
    }
    // DNS: the resolver gives up when the last wait runs out; otherwise lines follow the last packet
    const end = attempt.kind === 'dns' ? t : t + legMs
    ctx.dispatchPackets?.(packets)
    ctx.dispatchCaptures?.(captures)
    return { lines: at(end), endMs: end }
  }

  // Nothing leaves the device
  return { lines: at(startMs), endMs: startMs }
}
