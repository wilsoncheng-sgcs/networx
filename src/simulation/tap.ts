import type { CaptureRecord, NetEdge, NetNode } from '../types'
import { nodeById } from './network'

/**
 * Tap a link (spec §7.3): the capture shows only packets that cross one edge, with the MAC
 * addresses seen on that edge. IP addresses stay the same end to end; MAC addresses change at
 * every router. Switches, hubs and access points forward frames without being addressed,
 * so on a link next to one the MACs are those of the nearest layer-3 devices either side.
 */

const LAYER2_TYPES = ['switch', 'hub', 'wap']
const BROADCAST = 'ff:ff:ff:ff:ff:ff'

function isLayer2(id: string, nodes: NetNode[]): boolean {
  const n = nodeById(id, nodes)
  return !!n && LAYER2_TYPES.includes(n.data.deviceType)
}

/** Index of the hop in `route` that crosses `edge` (route[i] → route[i + 1]), or -1. */
export function hopIndex(route: string[], edge: Pick<NetEdge, 'source' | 'target'>): number {
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1]
    if ((a === edge.source && b === edge.target) || (a === edge.target && b === edge.source)) return i
  }
  return -1
}

/** Source and destination MAC of the frame on hop `i` of `route`. */
export function hopMacs(route: string[], i: number, nodes: NetNode[]): { srcMac: string; dstMac: string } {
  let from = i
  while (from > 0 && isLayer2(route[from]!, nodes)) from--
  let to = i + 1
  while (to < route.length - 1 && isLayer2(route[to]!, nodes)) to++
  return {
    srcMac: nodeById(route[from]!, nodes)?.data.mac ?? '',
    dstMac: nodeById(route[to]!, nodes)?.data.mac ?? BROADCAST,
  }
}

/** The record as seen on the tapped edge, or null when its packet doesn't cross that edge. */
export function tapView<T extends Pick<CaptureRecord, 'srcMac' | 'dstMac' | 'route'>>(
  record: T,
  edge: Pick<NetEdge, 'source' | 'target'>,
  nodes: NetNode[],
): T | null {
  if (!record.route) return null
  const i = hopIndex(record.route, edge)
  if (i < 0) return null
  const macs = hopMacs(record.route, i, nodes)
  // A broadcast stays a broadcast on every link it floods across
  return { ...record, srcMac: macs.srcMac, dstMac: record.dstMac === BROADCAST ? BROADCAST : macs.dstMac }
}

/** “Patient's Laptop ⇄ Home Gateway (Wi-Fi)” for the drawer note. */
export function tapLabel(edge: NetEdge, nodes: NetNode[]): string {
  const a = nodeById(edge.source, nodes)?.data.label ?? edge.source
  const b = nodeById(edge.target, nodes)?.data.label ?? edge.target
  // Wireless links are drawn animated and labelled Wi-Fi
  const wireless = !!edge.animated || /wi-?fi/i.test(String(edge.label ?? ''))
  return `${a} ⇄ ${b} (${wireless ? 'Wi-Fi' : 'wired'})`
}
