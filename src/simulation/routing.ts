import type { NetNode, NetEdge } from '../types'
import { findPath, sameSubnet, subnetToCidr } from './network'
import { isPrivateIp, privateRange } from './privateIp'
import { firstBlock, blockedExplain, type Flow } from './firewall'
import { ispCheck } from './isp'

export { isPrivateIp } from './privateIp'
export type { Flow } from './firewall'

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
  | 'blocked'           // a firewall rule dropped it (Phase 3)
  | 'no-route'          // the ISP has no route to a public network: dropped at the internet

/** Failures where the packets still travel part of the way (`reach`), and the sender times out. */
export function travelsPartWay(failure: RouteFailure): boolean {
  return failure === 'private' || failure === 'not-on-network' || failure === 'no-reply' || failure === 'blocked' || failure === 'no-route'
}

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
 * The cloud node stands for every internet host. With `flow` (the connection being started), the
 * firewalls on the way check their rules too.
 */
export function routeBetween(src: NetNode, dst: NetNode | null, dstIp: string, nodes: NetNode[], edges: NetEdge[], flow?: Flow): Route {
  const route = addressRoute(src, dst, dstIp, nodes, edges)
  if (!flow) return route
  // How far the first packet travels: all the way, or as far as the address rules let it
  const travelled = route.ok ? route.path
    : (travelsPartWay(route.failure) && route.failure !== 'blocked') ? route.reach
    : null
  if (!travelled) return route
  const block = firstBlock(travelled, flow, src.data.ip, dstIp, nodes, edges)
  if (!block) return route
  return { ok: false, failure: 'blocked', reach: travelled.slice(0, block.index + 1), explain: blockedExplain(block) }
}

/** The address rules alone (1–3 above). */
function addressRoute(src: NetNode, dst: NetNode | null, dstIp: string, nodes: NetNode[], edges: NetEdge[]): Route {
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

  // 2a. A public network is reachable across the internet only if the ISP has a route to it (and back)
  const isp = cloudAt >= 0 ? ispCheck(path, cloudAt + 1, src.data.ip, dstIp, dst.data.label, nodes) : null
  if (isp?.direction === 'to') return { ok: false, failure: 'no-route', reach: path.slice(0, cloudAt + 2), explain: isp.explain }

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

  // 3. The reply needs a way back (replies to a private sender come back through its NAT gateway).
  //    The destination makes its own sending decision with its own mask — even when the request came
  //    straight across the segment.
  if (HOST_TYPES.includes(dst.data.deviceType) && src.data.ip) {
    const back = nextHop(dst, src.data.ip, src, nodes, edges)
    if (!back.ok && back.failure !== 'no-address') {
      return {
        ok: false, failure: 'no-reply', reach: path,
        explain: `ⓘ ${dst.data.label} received the request but can't send the reply: ${back.explain.replace(/^ⓘ /, '')}`,
      }
    }
    // The reply goes to the destination's gateway: the router that hands it to the sender must be on the sender's network
    if (back.ok && back.firstHop.id !== src.id && HOST_TYPES.includes(src.data.deviceType)) {
      const rest = findPath(back.firstHop.id, src.id, nodes, edges)
      const replyPath = rest ? [...back.segment.slice(0, -1), ...rest] : null
      const at = replyPath ? deliveringRouter(replyPath, nodes) : -1
      const router = at >= 0 ? nodes.find((n) => n.id === replyPath![at]) : undefined
      if (router && router.data.deviceType !== 'cloud' && !onNetwork(router, src.data.ip)) {
        const gw = dst.data.gateway
        const srcNet = `${src.data.ip}/${subnetToCidr(maskOf(src))}`
        const dstNet = `${dst.data.ip}/${subnetToCidr(maskOf(dst))}`
        const explain = direct
          ? `ⓘ ${src.data.label} (${srcNet}) thinks ${dstIp} is on its own subnet, but ${dst.data.label} (${dstNet}) thinks ${src.data.ip} is on another one, so it sends the reply to its gateway ${gw} — which can't deliver it. Both ends of a subnet must use the same mask.`
          : `ⓘ ${dst.data.label} received the request but can't send the reply: it sends it to its gateway ${gw}, and ${router.data.label} can't deliver to ${src.data.ip} — that address isn't on ${router.data.label}'s network.`
        return { ok: false, failure: 'no-reply', reach: path, explain }
      }
    }
  }
  if (isp?.direction === 'back') return { ok: false, failure: 'no-reply', reach: path, explain: isp.explain }
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

/**
 * Does the device at `path[i]` route the packet (forward it between networks, lowering its TTL)?
 * Routers and firewalls always do; a home/office gateway only between its LAN and WAN sides — between
 * two of its LAN devices it is just a switch. Switches, hubs and access points never do.
 */
export function isRoutingHop(path: string[], i: number, nodes: NetNode[]): boolean {
  const type = (id: string | undefined) => nodes.find((n) => n.id === id)?.data.deviceType ?? ''
  const t = type(path[i])
  if (t === 'router' || t === 'firewall') return true
  if (t !== 'gateway') return false
  return ROUTING_TYPES.includes(type(path[i - 1])) || ROUTING_TYPES.includes(type(path[i + 1]))
}

/** Simulated internet backbone routers the Internet node stands for (traceroute shows them; each lowers the TTL). */
export const INTERNET_HOPS = [
  { ip: '195.68.128.1',  label: 'ISP Gateway'    },
  { ip: '62.115.52.22',  label: 'Backbone router' },
  { ip: '108.170.252.1', label: 'Exchange point'  },
]

/**
 * The TTL a packet arrives with after travelling `path` from a sender that starts at 64:
 * one less for every router on the way, and three less for the internet's backbone.
 * A path ending at the Internet node (an internet host) crosses the backbone too.
 */
export function ttlAfter(path: string[], nodes: NetNode[], start = 64): number {
  let ttl = start
  for (let i = 1; i < path.length; i++) {
    const last = i === path.length - 1
    const t = nodes.find((n) => n.id === path[i])?.data.deviceType
    if (t === 'cloud') ttl -= INTERNET_HOPS.length
    else if (!last && isRoutingHop(path, i, nodes)) ttl -= 1
  }
  return ttl
}

/** Short system error text for a failure, as tools print it. */
export function errnoText(failure: RouteFailure): string {
  switch (failure) {
    case 'net-unreachable': return 'Network is unreachable'
    case 'host-unreachable': return 'No route to host'
    case 'private':
    case 'not-on-network':
    case 'no-reply':
    case 'no-route': return 'Connection timed out'
    case 'blocked': return 'Operation timed out'
    case 'no-address': return 'Network is unreachable'
    default: return 'No route to host'
  }
}
