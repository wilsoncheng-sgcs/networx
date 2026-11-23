import type { NodeData, PendingCapture, NetNode, TerminalLine } from '../../types'
import type { TermContext } from '../context'
import { PRESETS } from '../presets'
import { normaliseNode } from '../defaults'
import { runCommand } from '../terminal'

/** A fresh copy of the CareConnect preset, normalised as the app loads it. */
export function careConnect() {
  const preset = PRESETS.find((p) => p.id === 'careconnect')!
  return {
    nodes: structuredClone(preset.nodes).map(normaliseNode) as NetNode[],
    edges: structuredClone(preset.edges),
  }
}

/** A context that records capture records and state changes instead of animating. */
export function testCtx(selfId: string, net = careConnect()) {
  const captures: PendingCapture[] = []
  const patches: Array<{ id: string; patch: Partial<NodeData> }> = []
  const ctx: TermContext = {
    selfId,
    nodes: net.nodes,
    edges: net.edges,
    dispatchCaptures: (c) => captures.push(...c),
    updateNodeData: (id, patch) => {
      patches.push({ id, patch })
      // Keep the snapshot current so a following command sees the change
      const node = net.nodes.find((n) => n.id === id)
      if (node) node.data = { ...node.data, ...patch }
    },
  }
  return { ctx, captures, patches, net }
}

/** Run a command line and return its lines plus every capture record it produced. */
export function run(selfId: string, command: string, net = careConnect()) {
  const t = testCtx(selfId, net)
  const lines = runCommand(command, t.ctx)
  return { ...t, lines, text: lines.map((l: TerminalLine) => l.text).join('\n') }
}

/** Capture records of the main (non-DNS, non-ARP) conversation. */
export function tcpRecords(captures: PendingCapture[]): PendingCapture[] {
  return captures.filter((c) => c.transport === 'TCP')
}
