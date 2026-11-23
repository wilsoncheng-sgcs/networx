import type {
  NetNode, NetEdge, TerminalLine, MacEntry, ArpEntry, PacketAnim, NodeData, PendingCapture, ConnRecord,
} from '../types'
import { nodeById } from './network'

/** Everything a command needs from the app. Optional callbacks are absent in unit tests. */
export interface TermContext {
  selfId: string
  nodes: NetNode[]
  edges: NetEdge[]
  learnMac?: (switchId: string, entry: MacEntry) => void
  learnArp?: (nodeId: string, entry: ArpEntry) => void
  dispatchPackets?: (packets: PacketAnim[]) => void
  updateNodeData?: (id: string, patch: Partial<NodeData>) => void
  dispatchCaptures?: (captures: PendingCapture[]) => void
  recordConnection?: (nodeId: string, conn: ConnRecord) => void
  /** This node's recent TCP connections, newest first (for plain netstat). */
  recentConnections?: ConnRecord[]
  /** ARP lookups already animated while running this command (the node snapshot doesn't update mid-command). */
  arpSeen?: Set<string>
}

export type Lines = TerminalLine[]

export function out(text: string, delayMs?: number): TerminalLine {
  return delayMs === undefined ? { type: 'output', text } : { type: 'output', text, delayMs }
}
export function err(text: string, delayMs?: number): TerminalLine {
  return delayMs === undefined ? { type: 'error', text } : { type: 'error', text, delayMs }
}
export function info(text: string, delayMs?: number): TerminalLine {
  return delayMs === undefined ? { type: 'info', text } : { type: 'info', text, delayMs }
}

/** Shift every line so it prints at least `ms` after the command ran. */
export function delayLines(lines: Lines, ms: number): Lines {
  if (!ms) return lines
  return lines.map((l) => ({ ...l, delayMs: (l.delayMs ?? 0) + ms }))
}

export function self(ctx: TermContext): NetNode {
  return nodeById(ctx.selfId, ctx.nodes)!
}
