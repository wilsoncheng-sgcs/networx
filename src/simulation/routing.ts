import type { NetNode, NetEdge } from '../types'
import { findPath, sameSubnet, subnetToCidr } from './network'

/**
 * Can a packet from `src` reach `dstIp`, and can the reply come back? (Address rules on top of the
 * cable search, so subnets, default gateways and private addresses behave as students are taught.)
 *
 * 1. A host compares the destination with its own IP and subnet mask:
 *    - same subnet → it delivers directly, which needs ARP to find the destination on its own
 *      network segment (only switches, hubs and access points in between);
 *    - different subnet → it sends to its default gateway, which must be on its own subnet.
 * 2. Private addresses (10/8, 172.16/12, 192.168/16) don't cross the internet: internet routers
 *    drop them, and a NAT gateway only lets replies back in. So nothing outside a private network
 *    can start a connection to a device inside it.
 * 3. The destination needs the same to send its reply back.
 * Routers, gateways and firewalls forward between networks; their own routing isn't modelled.
 */

/** Devices that make their own sending decision from IP address, mask and default gateway. */
export const HOST_TYPES = ['pc', 'laptop', 'server', 'dns', 'web', 'mail', 'file']
const LAYER2_TYPES = ['switch', 'hub', 'wap']

export type RouteFailure =
  | 'no-address'        // the sender has no IP address
  | 'net-unreachable'   // different subnet and no usable default gateway
  | 'host-unreachable'  // ARP got no answer (destination or gateway not on this segment)
  | 'private'           // private destination across the internet: dropped
  | 'not-on-network'    // the last router isn't on the destination's subnet: it never hands it over
  | 'no-reply'          // the destination can't send the reply back
  | 'no-path'           // no cable path at all

export type Route =
  | { ok: true; path: string[] }
  | {
      ok: false
      failure: RouteFailure
      /** How far the packets get before they are dropped (node ids), or null if nothing leaves. */
      reach: string[] | null
      /** The address ARP asked for, for host-unreachable. */
      arpFor?: string
      /** A teaching note for the terminal (starts with ⓘ). */
      explain: string
    }

const PRIVATE_RANGES: Array<[string, string]> = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
]

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some(([net, mask]) => sameSubnet(ip, net, mask))
}

function privateRange(ip: string): string {
  const r = PRIVATE_RANGES.find(([net, mask]) => sameSubnet(ip, net, mask))
  return r ? `${r[0]}/${subnetToCidr(r[1])}` : ''
}

/** A node answers on its LAN address, and a router or gateway also on its WAN address. */
export function nodeHasIp(n: NetNode, ip: string): boolean {
  return !!ip && (n.data.ip === ip || n.data.wanIp === ip)
}

function maskOf(n: NetNode): string {
  return n.data.subnet || '255.255.255.0'
}

const ROUTING_TYPES = ['router', 'gateway', 'firewall', 'cloud']

/**
 * A path on which every device between the two ends only forwards frames (one network segment):
 * switches, hubs and access points — and a home/office gateway between two of its LAN-side devices,
 * since it is a switch and access point as well as a router.
 */
export function findSegmentPath(aId: string, bId: string, nodes: NetNode[], edges: NetEdge[]): string[] | null {
  if (aId === bId) return [aId]
  const type = (id: string) => nodes.find((n) => n.id === id)?.data.deviceType ?? ''
  const on = (id: string) => nodes.find((n) => n.id === id)?.data.isOn !== false
  const lanSide = (id: string) => !ROUTING_TYPES.includes(type(id))
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
  }
  const seen = new Set([aId])
  const queue: string[][] = [[aId]]
  while (queue.length) {
    const path = queue.shift()!
    const last = path[path.length - 1]!
    const prev = path[path.length - 2]
    // Through a gateway's built-in switch: only from one LAN-side device to another
    const viaGateway = path.length > 1 && type(last) === 'gateway'
    for (const next of adj.get(last) ?? []) {
      if (viaGateway && !lanSide(next)) continue
      if (next === bId) return [...path, next]
      if (seen.has(next) || !on(next)) continue
      if (LAYER2_TYPES.includes(type(next)) || (type(next) === 'gateway' && lanSide(last) && prev !== next)) {
        seen.add(next)
        queue.push([...path, next])
      }
    }
  }
  return null
}

type Hop = { ok: true; firstHop: NetNode; segment: string[] } | { ok: false; failure: RouteFailure; arpFor?: string; explain: string }

/** The sending decision a host makes for `toIp` (rule 1). */
function nextHop(from: NetNode, toIp: string, to: NetNode | null, nodes: NetNode[], edges: NetEdge[]): Hop {
  const ip = from.data.ip
  if (!ip) return { ok: false, failure: 'no-address', explain: `ⓘ ${from.data.label} has no IP address. Set one in Configure, or get one with dhclient.` }
  const mask = maskOf(from)
  const cidr = subnetToCidr(mask)

  if (sameSubnet(ip, toIp, mask)) {
    const segment = to ? findSegmentPath(from.id, to.id, nodes, edges) : null
    if (!to || !segment || to.data.isOn === false) {
      return {
        ok: false, failure: 'host-unreachable', arpFor: toIp,
        explain: `ⓘ ${toIp} is on the same subnet as ${from.data.label} (${ip}/${cidr}), so it asked for its MAC address with ARP — and nothing answered. No device with that address is on this network segment. Check the IP addresses and subnet masks.`,
      }
    }
    return { ok: true, firstHop: to, segment }
  }

  const gw = from.data.gateway
  if (!gw) {
    return {
      ok: false, failure: 'net-unreachable',
      explain: `ⓘ ${toIp} is not on ${from.data.label}'s subnet (${ip}/${cidr}), and it has no default gateway to send it to. Set the Default Gateway in Configure.`,
    }
  }
  if (!sameSubnet(ip, gw, mask)) {
    return {
      ok: false, failure: 'net-unreachable',
      explain: `ⓘ ${toIp} is not on ${from.data.label}'s subnet (${ip}/${cidr}), and its default gateway ${gw} isn't on that subnet either, so it has nowhere to send the packet. Check the Default Gateway and the subnet mask.`,
    }
  }
  // A device plugged straight into the Internet node uses it as its gateway (it stands for the ISP's router)
  const gateway = nodes.find((n) => n.data.ip === gw)
    ?? nodes.find((n) => n.data.deviceType === 'cloud' && findSegmentPath(from.id, n.id, nodes, edges))
  const segment = gateway ? findSegmentPath(from.id, gateway.id, nodes, edges) : null
  if (!gateway || !segment || gateway.data.isOn === false) {
    return {
      ok: false, failure: 'host-unreachable', arpFor: gw,
      explain: `ⓘ ${toIp} is on another subnet, so ${from.data.label} sends it to its default gateway ${gw} — but asking for the gateway's MAC address with ARP got no answer. No device with that address is on this network segment.`,
    }
  }
  return { ok: true, firstHop: gateway, segment }
}

function crossesInternet(path: string[], nodes: NetNode[]): number {
  return path.findIndex((id) => nodes.find((n) => n.id === id)?.data.deviceType === 'cloud')
}

/**
 * Route from `src` to the device `dst` that answers on `dstIp` (null when no device has it).
 * The cloud node stands for every internet host.
 */
export function routeBetween(src: NetNode, dst: NetNode | null, dstIp: string, nodes: NetNode[], edges: NetEdge[]): Route {
  // 1. The sender's own decision
  let path: string[] | null
  if (HOST_TYPES.includes(src.data.deviceType)) {
    const hop = nextHop(src, dstIp, dst, nodes, edges)
    if (!hop.ok) return { ok: false, failure: hop.failure, reach: null, arpFor: hop.arpFor, explain: hop.explain }
    if (!dst) return { ok: false, failure: 'no-path', reach: hop.segment, explain: `ⓘ No device on this network has the address ${dstIp}.` }
    const rest = hop.firstHop.id === dst.id ? [dst.id] : findPath(hop.firstHop.id, dst.id, nodes, edges)
    path = rest ? [...hop.segment.slice(0, -1), ...rest] : null
  } else {
    path = dst ? findPath(src.id, dst.id, nodes, edges) : null
  }
  if (!dst || !path) return { ok: false, failure: 'no-path', reach: null, explain: `ⓘ There is no connection from ${src.data.label} to ${dstIp}.` }

  // 2. Private addresses stop at the internet
  const cloudAt = crossesInternet(path.slice(1, -1), nodes)
  if (isPrivateIp(dstIp) && cloudAt >= 0) {
    return {
      ok: false, failure: 'private', reach: path.slice(0, cloudAt + 2),
      explain: `ⓘ ${dstIp} is a private address (${privateRange(dstIp)}): it only exists inside its own network. Internet routers drop packets addressed to it, and the network's NAT gateway only lets replies back in — so nothing outside can start a connection to ${dst.data.label}. From outside, use a public address.`,
    }
  }

  // 2b. The router that hands the packet over must itself be on the destination's subnet — a device
  //     plugged into a gateway with an address from another network isn't reached
  const direct = HOST_TYPES.includes(src.data.deviceType) && !!src.data.ip && sameSubnet(src.data.ip, dstIp, maskOf(src))
  // Only end devices: a router owns its addresses and is reached across the links between routers,
  // and the Internet node stands for every internet host.
  const at = direct || !HOST_TYPES.includes(dst.data.deviceType) ? -1 : deliveringRouter(path, nodes)
  const router = at >= 0 ? nodes.find((n) => n.id === path[at]) : undefined
  if (router && router.data.deviceType !== 'cloud' && !onNetwork(router, dstIp)) {
    const cloud = nodes.find((n) => n.data.deviceType === 'cloud')
    const out = cloud ? findPath(router.id, cloud.id, nodes, edges) : null
    const outward = out && !out.includes(dst.id) ? out.slice(1) : []
    const net = `${router.data.ip}/${subnetToCidr(maskOf(router))}`
    const fate = outward.length
      ? `so it sends the packet out towards the internet instead${isPrivateIp(dstIp) ? ', where a private address is dropped' : ''}`
      : 'so it has nowhere to send the packet'
    return {
      ok: false, failure: 'not-on-network', reach: [...path.slice(0, at + 1), ...outward],
      explain: `ⓘ ${dstIp} isn't on ${router.data.label}'s network (${net}). Even though ${dst.data.label} is plugged into it, ${router.data.label} only delivers to addresses on its own networks — ${fate}. Give ${dst.data.label} an address on ${router.data.label}'s network (or use dhclient).`,
    }
  }

  // 3. The reply needs a way back (replies to a private sender come back through its NAT gateway)
  if (HOST_TYPES.includes(dst.data.deviceType) && src.data.ip) {
    const back = nextHop(dst, src.data.ip, src, nodes, edges)
    if (!back.ok && back.failure !== 'no-address') {
      return {
        ok: false, failure: 'no-reply', reach: path,
        explain: `ⓘ ${dst.data.label} received the request but can't send the reply: ${back.explain.replace(/^ⓘ /, '')}`,
      }
    }
  }
  return { ok: true, path }
}

/** Index on `path` of the router that hands the packet to the destination (skipping switches), or -1. */
function deliveringRouter(path: string[], nodes: NetNode[]): number {
  for (let i = path.length - 2; i >= 0; i--) {
    const t = nodes.find((n) => n.id === path[i])?.data.deviceType ?? ''
    if (LAYER2_TYPES.includes(t)) continue
    return ROUTING_TYPES.includes(t) ? i : -1
  }
  return -1
}

/** Is `ip` on one of this router's networks (its LAN, or its WAN side)? */
function onNetwork(router: NetNode, ip: string): boolean {
  if (router.data.ip && sameSubnet(router.data.ip, ip, maskOf(router))) return true
  return !!router.data.wanIp && sameSubnet(router.data.wanIp, ip, '255.255.255.0')
}

/** Short system error text for a failure, as tools print it. */
export function errnoText(failure: RouteFailure): string {
  switch (failure) {
    case 'net-unreachable': return 'Network is unreachable'
    case 'host-unreachable': return 'No route to host'
    case 'private':
    case 'not-on-network':
    case 'no-reply': return 'Connection timed out'
    case 'no-address': return 'Network is unreachable'
    default: return 'No route to host'
  }
}
