import { create } from 'zustand'
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import type { NodeChange, EdgeChange, Connection } from '@xyflow/react'
import type { NetNode, NetEdge, NodeData, PanelType, RouteEntry, MacEntry, ArpEntry, FirewallRule, DnsRecord, TerminalLine, PacketAnim, AnimSpeed, CaptureRecord, PendingCapture, ConnRecord } from '../types'
import { tapView } from '../simulation/tap'
import { setAnimSpeed, setStepping, scaledHop } from '../simulation/packets'
import * as clock from '../simulation/clock'
import { makeDefaultData, normaliseNetwork } from '../simulation/defaults'
import { clearAllDnsCaches } from '../simulation/dnsCache'
import type { Preset } from '../simulation/presets'

const STORAGE_KEY = 'networx-state-v1'
const SPEED_KEY = 'networx-speed'
const MAX_CAPTURES = 500
const MAX_RECENT_CONNS = 10

function loadSpeed(): AnimSpeed {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    if (raw === 'instant') return 'instant'
    const n = Number(raw)
    if (n === 0.5 || n === 1 || n === 3) return n
  } catch { /* storage unavailable */ }
  return 1
}

let idCounter = 100
function nextId(prefix: string) { return `${prefix}-${++idCounter}` }

// Try to restore saved state on first load
function loadSaved(): { nodes: NetNode[]; edges: NetEdge[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { nodes: NetNode[]; edges: NetEdge[] }
    return { nodes: normaliseNetwork(parsed.nodes ?? [], parsed.edges ?? []), edges: parsed.edges ?? [] }
  } catch {
    return null
  }
}

interface NetworkStore {
  nodes: NetNode[]
  edges: NetEdge[]
  selectedNodeId: string | null
  activePanel: PanelType
  connectionType: 'wired' | 'wireless'
  showLayers: boolean

  // ReactFlow handlers
  onNodesChange: (changes: NodeChange<NetNode>[]) => void
  onEdgesChange: (changes: EdgeChange<NetEdge>[]) => void
  onConnect: (connection: Connection) => void

  // Node management
  addDevice: (type: NetNode['data']['deviceType'], position: { x: number; y: number }) => void
  updateNodeData: (id: string, data: Partial<NodeData>) => void
  selectNode: (id: string | null) => void
  deleteSelected: () => void

  // Panel
  setPanel: (panel: PanelType) => void

  // Connection type
  setConnectionType: (t: 'wired' | 'wireless') => void

  // Layer visibility
  toggleLayers: () => void

  // Terminal
  appendTermLine: (nodeId: string, line: TerminalLine) => void
  clearTerm: (nodeId: string) => void

  // Switch MAC learning
  learnMac: (nodeId: string, entry: MacEntry) => void
  // Host/router ARP learning
  learnArp: (nodeId: string, entry: ArpEntry) => void

  // Routing table
  addRoute: (nodeId: string, route: RouteEntry) => void
  removeRoute: (nodeId: string, index: number) => void

  // Firewall
  addRule: (nodeId: string, rule: FirewallRule) => void
  removeRule: (nodeId: string, id: string) => void

  // DNS records
  addDnsRecord: (nodeId: string, record: DnsRecord) => void
  removeDnsRecord: (nodeId: string, id: string) => void

  // Animation speed (toolbar). Persisted separately from the network.
  animSpeed: AnimSpeed
  setAnimSpeed: (speed: AnimSpeed) => void

  // Step mode (spec §7.4): Conversations pause before each Step until Next
  stepMode: boolean
  stepPaused: boolean
  stepLabel: string
  toggleStepMode: () => void
  stepNext: () => void

  // Packet animations
  activePackets: PacketAnim[]
  dispatchPackets: (packets: PacketAnim[]) => void

  // Packet capture (not persisted)
  captures: CaptureRecord[]
  captureOpen: boolean
  captureStartMs: number
  setCaptureOpen: (open: boolean) => void
  clearCaptures: () => void
  addCapture: (record: Omit<CaptureRecord, 'no' | 'timeMs'>) => void
  dispatchCaptures: (records: PendingCapture[]) => void
  /** Tap a link: record only packets crossing this edge (null = every packet). */
  tapEdgeId: string | null
  setTap: (edgeId: string | null) => void

  // Recent TCP connections per node, newest first (not persisted; for netstat)
  recentConns: Record<string, ConnRecord[]>
  recordConnection: (nodeId: string, conn: ConnRecord) => void

  // Bumped when a whole network is loaded, so the canvas re-fits the view
  layoutVersion: number

  // Persistence & presets
  saveToStorage: () => void
  loadPreset: (preset: Preset) => void
  clearCanvas: () => void
}

const saved = loadSaved()
const initialSpeed = loadSpeed()
setAnimSpeed(initialSpeed)

export const useNetworkStore = create<NetworkStore>((set, get) => ({
  nodes: saved?.nodes ?? [],
  edges: saved?.edges ?? [],
  selectedNodeId: null,
  activePanel: null,
  connectionType: 'wired',
  showLayers: false,
  activePackets: [],
  animSpeed: initialSpeed,
  stepMode: false,
  stepPaused: false,
  stepLabel: '',
  captures: [],
  captureOpen: false,
  captureStartMs: Date.now(),
  tapEdgeId: null,
  recentConns: {},
  layoutVersion: 0,

  onNodesChange: (changes) =>
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) })),

  onEdgesChange: (changes) =>
    set((s) => {
      const edges = applyEdgeChanges(changes, s.edges)
      // Deleting the tapped link ends the tap
      const tapEdgeId = s.tapEdgeId && edges.some((e) => e.id === s.tapEdgeId) ? s.tapEdgeId : null
      return { edges, tapEdgeId }
    }),

  onConnect: (connection) => {
    const ctype = get().connectionType
    set((s) => ({
      edges: addEdge(
        {
          ...connection,
          animated: ctype === 'wireless',
          style: ctype === 'wireless'
            ? { stroke: '#6366f1', strokeDasharray: '6 3' }
            : { stroke: '#374151' },
          data: { connectionType: ctype },
          label: ctype === 'wireless' ? 'Wi-Fi' : undefined,
        },
        s.edges,
      ),
    }))
  },

  addDevice: (type, position) => {
    const id = nextId(type)
    const data = makeDefaultData(type, id)
    set((s) => {
      // A new device gets the network's DNS server (and a new router hands it out), as on load
      const [added] = normaliseNetwork([...s.nodes, { id, type: 'device', position, data }], s.edges).slice(-1)
      return { nodes: [...s.nodes, added!] }
    })
  },

  updateNodeData: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    })),

  selectNode: (id) => set({ selectedNodeId: id }),

  deleteSelected: () => {
    const { selectedNodeId } = get()
    if (!selectedNodeId) return
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== selectedNodeId),
      edges: s.edges.filter(
        (e) => e.source !== selectedNodeId && e.target !== selectedNodeId,
      ),
      selectedNodeId: null,
      activePanel: null,
    }))
  },

  setPanel: (panel) => set({ activePanel: panel }),

  setConnectionType: (t) => set({ connectionType: t }),

  toggleLayers: () => set((s) => ({ showLayers: !s.showLayers })),

  appendTermLine: (nodeId, line) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, termHistory: [...n.data.termHistory, line] } }
          : n,
      ),
    })),

  clearTerm: (nodeId) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, termHistory: [] } } : n,
      ),
    })),

  learnMac: (nodeId, entry) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, macTable: [...n.data.macTable.filter((m) => m.mac !== entry.mac), entry] } }
          : n,
      ),
    })),

  learnArp: (nodeId, entry) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...n.data,
                arpTable: [
                  ...(n.data.arpTable ?? []).filter((a) => a.ip !== entry.ip),
                  entry,
                ],
              },
            }
          : n,
      ),
    })),

  addRoute: (nodeId, route) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, routingTable: [...n.data.routingTable, route] } }
          : n,
      ),
    })),

  removeRoute: (nodeId, index) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, routingTable: n.data.routingTable.filter((_, i) => i !== index) } }
          : n,
      ),
    })),

  addRule: (nodeId, rule) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, rules: [...n.data.rules, rule] } }
          : n,
      ),
    })),

  removeRule: (nodeId, ruleId) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, rules: n.data.rules.filter((r) => r.id !== ruleId) } }
          : n,
      ),
    })),

  addDnsRecord: (nodeId, record) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, dnsRecords: [...(n.data.dnsRecords ?? []), record] } }
          : n,
      ),
    })),

  removeDnsRecord: (nodeId, recordId) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, dnsRecords: (n.data.dnsRecords ?? []).filter((r) => r.id !== recordId) } }
          : n,
      ),
    })),

  setAnimSpeed: (speed) => {
    setAnimSpeed(speed)
    try { localStorage.setItem(SPEED_KEY, String(speed)) } catch { /* storage unavailable */ }
    set({ animSpeed: speed })
  },

  dispatchPackets: (packets) => {
    // Instant: nothing animates
    if (scaledHop(1) === 0) return
    // Stagger each packet's appearance on the shared clock so animateMotion starts at t=0
    // (and step mode can hold it back)
    packets.forEach((packet) => {
      clock.after(packet.delayMs, () => {
        set((s) => ({ activePackets: [...s.activePackets, packet] }))
        // A packet a firewall dropped stays a moment longer, so its ✕ can be seen
        clock.after(packet.durationMs + (packet.dropped ? 1500 : 150), () => {
          set((s) => ({ activePackets: s.activePackets.filter((p) => p.id !== packet.id) }))
        })
      })
    })
  },

  toggleStepMode: () => {
    const on = !get().stepMode
    setStepping(on)
    clock.setStepMode(on)
    set({ stepMode: on })
  },

  stepNext: () => clock.next(),

  setCaptureOpen: (open) => set({ captureOpen: open }),

  clearCaptures: () => set({ captures: [], captureStartMs: Date.now() }),

  addCapture: (record) =>
    set((s) => {
      const no = (s.captures[s.captures.length - 1]?.no ?? 0) + 1
      const full: CaptureRecord = { ...record, no, timeMs: Date.now() - s.captureStartMs }
      return { captures: [...s.captures, full].slice(-MAX_CAPTURES) }
    }),

  dispatchCaptures: (records) => {
    // Step mode: pause before each Step of a Conversation (its capture record is due when the Step starts)
    clock.addBreakpoints(records
      .filter((r) => r.conversationId.startsWith('conv-'))
      .map((r) => ({ delayMs: r.delayMs, label: r.info.replace(/^🔒 /, '') })))
    // A tapped link sees only the packets that cross it, with that link's MAC addresses
    const { tapEdgeId, edges, nodes } = get()
    const tap = tapEdgeId ? edges.find((e) => e.id === tapEdgeId) : undefined
    const visible = tap
      ? records.flatMap((r) => {
          const seen = tapView(r, tap, nodes)
          return seen ? [{ ...seen, tapped: true }] : []
        })
      : records
    // Each record appears when its packet leaves, so the list grows in time with the animation
    visible.forEach(({ delayMs, ...record }) => {
      clock.after(delayMs, () => get().addCapture(record))
    })
  },

  setTap: (edgeId) => set({ tapEdgeId: edgeId, ...(edgeId ? { captureOpen: true } : {}) }),

  recordConnection: (nodeId, conn) =>
    set((s) => ({
      recentConns: {
        ...s.recentConns,
        [nodeId]: [conn, ...(s.recentConns[nodeId] ?? [])].slice(0, MAX_RECENT_CONNS),
      },
    })),

  saveToStorage: () => {
    const { nodes, edges } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, edges }))
    } catch { /* quota exceeded — silently skip */ }
  },

  loadPreset: (preset) => {
    clearAllDnsCaches()
    set({
      nodes: normaliseNetwork(preset.nodes, preset.edges),
      edges: preset.edges,
      layoutVersion: get().layoutVersion + 1,
      recentConns: {},
      selectedNodeId: null,
      activePanel: null,
      tapEdgeId: null,
    })
  },

  clearCanvas: () => {
    set({ nodes: [], edges: [], selectedNodeId: null, activePanel: null, tapEdgeId: null })
    localStorage.removeItem(STORAGE_KEY)
  },
}))

// The clock pauses and resumes by itself in step mode; mirror that for the toolbar
clock.subscribe((c) => useNetworkStore.setState({ stepPaused: c.paused, stepLabel: c.nextLabel }))
