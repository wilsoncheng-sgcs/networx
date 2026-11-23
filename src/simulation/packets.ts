import type { NetNode, NetEdge, PacketAnim, AnimSpeed, PendingCapture } from '../types'
import type { TermContext } from './context'
import { findPath, nodeByIp, nodeById, sameSubnet } from './network'

// ── Animation speed ──────────────────────────────────────────────────────────

/** Per-hop time for the existing single-leg commands (ping, DHCP …) at Normal speed. */
export const HOP_MS = 500

let animSpeed: AnimSpeed = 1
let stepping = false

/** Set by the store whenever the toolbar Speed control changes. */
export function setAnimSpeed(speed: AnimSpeed): void { animSpeed = speed }
export function getAnimSpeed(): AnimSpeed { return animSpeed }

/** Step mode needs packets to watch, so Instant plays at Fast while it is on. */
export function setStepping(on: boolean): void { stepping = on }

/** A base per-hop time scaled by the current speed (0 when Instant). */
export function scaledHop(baseMs: number): number {
  if (animSpeed === 'instant') return stepping ? baseMs / 3 : 0
  return baseMs / animSpeed
}

let packetSequence = 0

export function nextBatchId(): string {
  return `${Date.now()}-${++packetSequence}`
}

// ── Paths and legs ───────────────────────────────────────────────────────────

export function segmentsOnPath(
  nodeIds: string[],
  edges: NetEdge[],
): Array<{ edgeId: string; reverse: boolean }> {
  return nodeIds.slice(0, -1).flatMap((nid, i) => {
    const next = nodeIds[i + 1]
    const e = edges.find(
      (e) => (e.source === nid && e.target === next) || (e.source === next && e.target === nid),
    )
    return e ? [{ edgeId: e.id, reverse: e.source !== nid }] : []
  })
}

export function edgesOnPath(nodeIds: string[], edges: NetEdge[]): string[] {
  return segmentsOnPath(nodeIds, edges).map(({ edgeId }) => edgeId)
}

export function makePackets(
  nodeIds: string[],
  allEdges: NetEdge[],
  protocol: PacketAnim['protocol'],
  label: string,
  withReply = false,
): PacketAnim[] {
  const hop = scaledHop(HOP_MS)
  const segments = segmentsOnPath(nodeIds, allEdges)
  const N = segments.length
  const batchId = nextBatchId()
  const forward: PacketAnim[] = segments.map(({ edgeId, reverse }, i) => ({
    id: `pkt-${batchId}-f${i}`,
    edgeId, protocol, label,
    delayMs: i * hop,
    durationMs: hop,
    reverse,
  }))
  if (!withReply) return forward
  const replyLabel = protocol === 'ICMP' || protocol === 'ARP' ? 'reply' : `${label} ↩`
  const reply: PacketAnim[] = [...segments].reverse().map(({ edgeId, reverse }, i) => ({
    id: `pkt-${batchId}-r${i}`,
    edgeId, protocol,
    label: replyLabel,
    delayMs: (N + i) * hop,
    durationMs: hop,
    reverse: !reverse,
  }))
  return [...forward, ...reply]
}

/** One leg of a multi-step exchange, outbound along `path` or back along it. */
export function leg(
  path: string[],
  edges: NetEdge[],
  protocol: PacketAnim['protocol'],
  label: string,
  startMs: number,
  back = false,
  hop = scaledHop(HOP_MS),
): PacketAnim[] {
  const segments = segmentsOnPath(path, edges)
  const ordered = back ? [...segments].reverse() : segments
  const batchId = nextBatchId()
  return ordered.map(({ edgeId, reverse }, i) => ({
    id: `pkt-${batchId}-${i}`,
    edgeId, protocol, label,
    delayMs: startMs + i * hop,
    durationMs: hop,
    reverse: back ? !reverse : reverse,
  }))
}

/** When the last packet in an animation finishes, in ms from dispatch. */
export function finishMs(packets: PacketAnim[]): number {
  return packets.reduce((end, p) => Math.max(end, p.delayMs + p.durationMs), 0)
}

/** Shift an animation so it starts `ms` later — used to hold data packets until DNS has answered. */
export function startAfter(packets: PacketAnim[], ms: number): PacketAnim[] {
  return ms ? packets.map((p) => ({ ...p, delayMs: p.delayMs + ms })) : packets
}

// ── Layer-2 learning ─────────────────────────────────────────────────────────

const LAYER2_TYPES = ['switch', 'hub', 'wap']

/** Source and destination MAC of the first hop when `path[0]` sends towards the end of `path`. */
export function firstHopMacs(path: string[], nodes: NetNode[]): { srcMac: string; dstMac: string } {
  const src = nodeById(path[0]!, nodes)
  // Layer-2 devices forward frames without being addressed: the frame is for the next layer-3 device
  const nextL3 = path.slice(1).map((id) => nodeById(id, nodes)).find((n) => n && !LAYER2_TYPES.includes(n.data.deviceType))
  return { srcMac: src?.data.mac ?? '', dstMac: nextL3?.data.mac ?? 'ff:ff:ff:ff:ff:ff' }
}

/** When a packet path traverses a switch, learn MAC→port mappings. */
export function populateMacTables(path: string[], ctx: TermContext): void {
  if (!ctx.learnMac) return
  for (let i = 0; i < path.length; i++) {
    const node = nodeById(path[i]!, ctx.nodes)
    if (!node || node.data.deviceType !== 'switch') continue  // hubs don't learn MACs

    // Assign port numbers by sorting the switch's connected edges
    const switchEdges = ctx.edges
      .filter((e) => e.source === path[i] || e.target === path[i])
      .sort((a, b) => a.id.localeCompare(b.id))

    const portFor = (neighbourId: string): string => {
      const idx = switchEdges.findIndex(
        (e) => (e.source === path[i] ? e.target : e.source) === neighbourId,
      )
      return `Gi0/${idx >= 0 ? idx + 1 : 1}`
    }

    // Learn MAC of the node the packet arrived from
    if (i > 0) {
      const prev = nodeById(path[i - 1]!, ctx.nodes)
      if (prev?.data.mac) {
        ctx.learnMac(path[i]!, { mac: prev.data.mac, port: portFor(path[i - 1]!), vlan: 1 })
      }
    }
    // Learn MAC of the next-hop node (from the return packet)
    if (i < path.length - 1) {
      const next = nodeById(path[i + 1]!, ctx.nodes)
      if (next?.data.mac) {
        ctx.learnMac(path[i]!, { mac: next.data.mac, port: portFor(path[i + 1]!), vlan: 1 })
      }
    }
  }
}

function populateArpTables(src: NetNode, dst: NetNode, ctx: TermContext): void {
  if (!ctx.learnArp || !src.data.ip || !dst.data.ip || !src.data.subnet) return

  if (sameSubnet(src.data.ip, dst.data.ip, src.data.subnet)) {
    ctx.learnArp(src.id, { ip: dst.data.ip, mac: dst.data.mac, iface: 'eth0' })
    if (dst.data.subnet && sameSubnet(dst.data.ip, src.data.ip, dst.data.subnet)) {
      ctx.learnArp(dst.id, { ip: src.data.ip, mac: src.data.mac, iface: 'eth0' })
    }
    return
  }

  const gateway = nodeByIp(src.data.gateway, ctx.nodes)
  if (gateway?.data.mac) {
    ctx.learnArp(src.id, { ip: gateway.data.ip, mac: gateway.data.mac, iface: 'eth0' })
    ctx.learnArp(gateway.id, { ip: src.data.ip, mac: src.data.mac, iface: 'eth0' })
  }
}

/**
 * ARP request/reply needed before `src` can send towards `dst` (to `dst` itself on the same
 * subnet, else to the default gateway). Empty when the cache already has the entry.
 * Learns the ARP entries and adds ARP capture records.
 */
export function arpBefore(
  src: NetNode,
  dst: NetNode,
  ctx: TermContext,
  startMs = 0,
): { packets: PacketAnim[]; captures: PendingCapture[]; endMs: number } {
  const none = { packets: [], captures: [], endMs: startMs }
  let arpTarget: NetNode | undefined
  let arpPath: string[] | null = null
  if (src.data.ip && dst.data.ip && src.data.subnet && sameSubnet(src.data.ip, dst.data.ip, src.data.subnet)) {
    arpTarget = dst
    arpPath = findPath(src.id, dst.id, ctx.nodes, ctx.edges)
  } else if (src.data.gateway) {
    arpTarget = nodeByIp(src.data.gateway, ctx.nodes)
    arpPath = arpTarget ? findPath(src.id, arpTarget.id, ctx.nodes, ctx.edges) : null
  }
  if (!arpTarget || !arpPath || arpPath.length < 2) return none

  const key = `${src.id}>${arpTarget.data.ip}`
  const cached = (src.data.arpTable ?? []).some(
    (entry) => entry.ip === arpTarget!.data.ip && entry.mac === arpTarget!.data.mac,
  )
  if (cached || ctx.arpSeen?.has(key)) return none
  ctx.arpSeen?.add(key)
  populateArpTables(src, dst, ctx)

  const hop = scaledHop(HOP_MS)
  const legMs = (arpPath.length - 1) * hop
  const packets = [
    ...leg(arpPath, ctx.edges, 'ARP', 'request', startMs, false, hop),
    ...leg(arpPath, ctx.edges, 'ARP', 'reply', startMs + legMs, true, hop),
  ]
  const convId = `arp-${nextBatchId()}`
  const base = { conversationId: convId, transport: 'ARP' as const, app: 'ARP' as const, encrypted: false, length: 28 }
  const captures: PendingCapture[] = [
    { ...base, stepIndex: 0, delayMs: startMs, route: arpPath,
      srcIp: src.data.ip, dstIp: arpTarget.data.ip,
      srcMac: src.data.mac, dstMac: 'ff:ff:ff:ff:ff:ff',
      info: `Who has ${arpTarget.data.ip}? Tell ${src.data.ip}` },
    { ...base, stepIndex: 1, delayMs: startMs + legMs, route: [...arpPath].reverse(),
      srcIp: arpTarget.data.ip, dstIp: src.data.ip,
      srcMac: arpTarget.data.mac, dstMac: src.data.mac,
      info: `${arpTarget.data.ip} is at ${arpTarget.data.mac}` },
  ]
  return { packets, captures, endMs: startMs + 2 * legMs }
}

export function makePacketsWithArp(
  src: NetNode,
  dst: NetNode,
  path: string[],
  ctx: TermContext,
  protocol: PacketAnim['protocol'],
  label: string,
  withReply = false,
): PacketAnim[] {
  populateMacTables(path, ctx)
  const arp = arpBefore(src, dst, ctx)
  if (arp.captures.length) ctx.dispatchCaptures?.(arp.captures)
  const dataPackets = makePackets(path, ctx.edges, protocol, label, withReply)
  return [...arp.packets, ...startAfter(dataPackets, arp.endMs)]
}
