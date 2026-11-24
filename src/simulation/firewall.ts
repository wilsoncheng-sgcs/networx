import type { NetNode, NetEdge, FirewallRule } from '../types'
import { isPrivateIp } from './privateIp'

/**
 * Firewall rules (spec §8). Rules are checked when a connection starts — the first SYN, the UDP
 * query, the ICMP echo — on every firewall, and every gateway that routes the packet, on its path.
 * Stateful: replies and the later packets of an allowed connection always pass.
 *
 * - Direction: `in` = the connection was started from the device's WAN side (the neighbour on the
 *   way to the Internet node); `out` = from its LAN side. With no Internet node, everything is `out`.
 * - First matching rule wins, top to bottom; no match → allow.
 * - A rule matches on protocol (TCP/UDP/ICMP/ANY), destination port (* or a number; ICMP has no port),
 *   and source/destination IP (* or exact). The source IP is the one the firewall sees: after a NAT
 *   gateway, a private sender appears as the gateway's public (WAN) address.
 */

export interface Flow {
  protocol: 'TCP' | 'UDP' | 'ICMP'
  /** Destination port (TCP and UDP). */
  port?: number
}

export interface Blocked {
  /** Index on the path of the device that dropped the packet. */
  index: number
  node: NetNode
  rule: FirewallRule
  ruleNumber: number
  direction: 'in' | 'out'
}

const ROUTING_TYPES = ['router', 'gateway', 'firewall', 'cloud']

function typeOf(id: string | undefined, nodes: NetNode[]): string {
  return nodes.find((n) => n.id === id)?.data.deviceType ?? ''
}

/** The neighbour of `id` on the shortest way to an Internet node (its WAN side), or null. */
export function wanNeighbour(id: string, nodes: NetNode[], edges: NetEdge[]): string | null {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
  }
  const seen = new Set([id])
  const queue: Array<{ at: string; first: string }> = (adj.get(id) ?? []).map((n) => ({ at: n, first: n }))
  queue.forEach((q) => seen.add(q.at))
  while (queue.length) {
    const { at, first } = queue.shift()!
    if (typeOf(at, nodes) === 'cloud') return first
    for (const next of adj.get(at) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push({ at: next, first })
    }
  }
  return null
}

/** Does the device at path[i] route here (so its firewall applies)? Firewalls always; gateways between LAN and WAN. */
function filtersHere(path: string[], i: number, nodes: NetNode[]): boolean {
  const t = typeOf(path[i], nodes)
  if (t === 'firewall') return true
  if (t !== 'gateway') return false
  return ROUTING_TYPES.includes(typeOf(path[i - 1], nodes)) || ROUTING_TYPES.includes(typeOf(path[i + 1], nodes))
}

const matchesIp = (pattern: string, ip: string) => !pattern.trim() || pattern.trim() === '*' || pattern.trim() === ip

export function ruleMatches(rule: FirewallRule, flow: Flow, direction: 'in' | 'out', srcIp: string, dstIp: string): boolean {
  if (rule.direction !== direction) return false
  if (rule.protocol !== 'ANY' && rule.protocol !== flow.protocol) return false
  const port = rule.port.trim()
  if (port && port !== '*') {
    if (flow.protocol === 'ICMP' || flow.port === undefined || Number(port) !== flow.port) return false
  }
  return matchesIp(rule.srcIp, srcIp) && matchesIp(rule.dstIp, dstIp)
}

/** A rule in a few words, e.g. `in TCP 21 deny`. */
export function ruleText(rule: FirewallRule): string {
  const ips = [rule.srcIp, rule.dstIp].some((ip) => ip.trim() && ip.trim() !== '*')
    ? ` from ${rule.srcIp || '*'} to ${rule.dstIp || '*'}`
    : ''
  return `${rule.direction} ${rule.protocol} ${rule.port || '*'}${ips} ${rule.action}`
}

/**
 * Walk the path a new connection takes and return the first device whose rules drop it, or null.
 * `path[0]` is the client; it doesn't filter its own traffic.
 */
export function firstBlock(path: string[], flow: Flow, srcIp: string, dstIp: string, nodes: NetNode[], edges: NetEdge[]): Blocked | null {
  let seenSrc = srcIp
  for (let i = 1; i < path.length; i++) {
    const node = nodes.find((n) => n.id === path[i])
    if (!node) continue
    if (filtersHere(path, i, nodes) && node.data.isOn !== false) {
      const wan = wanNeighbour(node.id, nodes, edges)
      const direction = wan && path[i - 1] === wan ? 'in' : 'out'
      const rules = node.data.rules ?? []
      const at = rules.findIndex((r) => ruleMatches(r, flow, direction, seenSrc, dstIp))
      if (at >= 0 && rules[at]!.action === 'deny') {
        return { index: i, node, rule: rules[at]!, ruleNumber: at + 1, direction }
      }
      // NAT: going out through a gateway, a private sender takes the gateway's public address
      const wanIp = node.data.wanIp
      if (node.data.deviceType === 'gateway' && direction === 'out' && wanIp && isPrivateIp(seenSrc) && i < path.length - 1 && path[i + 1] === wan) {
        seenSrc = wanIp
      }
    }
  }
  return null
}

/** The ⓘ line for a dropped connection. */
export function blockedExplain(b: Blocked): string {
  const side = b.direction === 'in'
    ? 'it was started from the internet side (inbound)'
    : 'it was started from the network side (outbound)'
  return `ⓘ ${b.node.data.label}'s firewall dropped it: rule ${b.ruleNumber} (${ruleText(b.rule)}) matched — ${side}. A dropped packet gets no reply, so the client waits and times out.`
}
