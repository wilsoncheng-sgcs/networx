import type { NetNode, NetEdge, IspRoute } from '../types'
import { findPath, sameSubnet, subnetToCidr, networkRange, ipToInt } from './network'
import { isPrivateIp, privateRange } from './privateIp'
import { isIpv4 } from './dns'

/**
 * The ISP routing table on the Internet node: which public networks the internet can reach, and the
 * router each one is behind (its next hop, the router's WAN address). A public address with no route
 * here is dropped at the ISP, like any address nobody announces. Private ranges are never carried.
 *
 * An Internet node without a table (a network built in code, before this existed) reaches every public
 * network, as Networx always did; `normaliseNetwork` gives loaded networks a table that keeps that.
 */

const NEXT_HOP_TYPES = ['router', 'gateway', 'firewall']
const nodeById = (id: string | undefined, nodes: NetNode[]) => nodes.find((n) => n.id === id)

/** The address a device has on the internet side: its WAN address, or (a firewall) its only address. */
export function outsideAddress(n: NetNode): string {
  return (n.data.wanIp as string | undefined) || n.data.ip
}

/** `a.b.c.d/nn` for a route. */
export function routePrefix(r: Pick<IspRoute, 'destination' | 'subnet'>): string {
  return `${r.destination}/${subnetToCidr(r.subnet)}`
}

/** The network a router's LAN is on, as a route destination. */
export function lanNetwork(router: NetNode): { destination: string; subnet: string } {
  const subnet = router.data.subnet || '255.255.255.0'
  return { destination: networkRange(router.data.ip, subnet).network, subnet }
}

/** The most specific route that covers `ip` (longest prefix wins). */
export function ispRouteFor(routes: IspRoute[], ip: string): IspRoute | undefined {
  return routes
    .filter((r) => isIpv4(r.destination) && sameSubnet(ip, r.destination, r.subnet))
    .sort((a, b) => subnetToCidr(b.subnet) - subnetToCidr(a.subnet))[0]
}

/**
 * The devices that can be an ISP route's next hop for traffic going in at `path[0]` (the side next to
 * the Internet node first): every router, gateway or firewall on the way. A firewall between the
 * Internet node and a router passes the router's traffic on, like a transparent (bridge-mode) firewall.
 */
function hopsOn(path: string[], nodes: NetNode[]): NetNode[] {
  return path.map((id) => nodeById(id, nodes)).filter((n): n is NetNode =>
    !!n && NEXT_HOP_TYPES.includes(n.data.deviceType) && !!outsideAddress(n))
}

/** The Internet node a router reaches the internet through, and the routers/firewalls on the way. */
export function internetEntry(router: NetNode, nodes: NetNode[], edges: NetEdge[]): { cloud: NetNode; hops: NetNode[] } | null {
  for (const cloud of nodes.filter((n) => n.data.deviceType === 'cloud')) {
    const path = findPath(cloud.id, router.id, nodes, edges)
    if (!path || path.length < 2 || !NEXT_HOP_TYPES.includes(nodeById(path[1], nodes)?.data.deviceType ?? '')) continue
    const hops = hopsOn(path.slice(1), nodes)
    if (hops.length) return { cloud, hops }
  }
  return null
}

/** The next hop to announce a router's LAN with: its own WAN address, else the first device on the way. */
function preferredHop(router: NetNode, hops: NetNode[]): string {
  return (router.data.wanIp as string | undefined) || outsideAddress(hops[0]!)
}

/** Is `router`'s LAN announced to the internet? (The Routing tab shows this; Announce adds it.) */
export function announcement(router: NetNode, nodes: NetNode[], edges: NetEdge[]):
  | { state: 'private'; prefix: string; range: string }
  | { state: 'no-internet' | 'no-address'; prefix: string }
  | { state: 'announced' | 'not-announced' | 'wrong-hop'; prefix: string; cloud: NetNode; nextHop: string; route?: IspRoute } {
  if (!router.data.ip || !isIpv4(router.data.ip)) return { state: 'no-address', prefix: '' }
  const lan = lanNetwork(router)
  const prefix = routePrefix(lan)
  if (isPrivateIp(router.data.ip)) return { state: 'private', prefix, range: privateRange(router.data.ip) }
  const at = internetEntry(router, nodes, edges)
  if (!at) return { state: 'no-internet', prefix }
  const nextHop = preferredHop(router, at.hops)
  const routes = at.cloud.data.ispRoutes
  if (!Array.isArray(routes)) return { state: 'announced', prefix, cloud: at.cloud, nextHop }
  const route = routes.find((r) => r.destination === lan.destination && r.subnet === lan.subnet)
    ?? ispRouteFor(routes, router.data.ip)
  if (!route) return { state: 'not-announced', prefix, cloud: at.cloud, nextHop }
  const ok = at.hops.some((h) => outsideAddress(h) === route.nextHop)
  return { state: ok ? 'announced' : 'wrong-hop', prefix, cloud: at.cloud, nextHop, route }
}

/**
 * The ISP routes that keep a network working as it did before ISP routing tables: every router,
 * gateway or firewall with a public LAN, through the device that connects it to the Internet node.
 */
export function defaultIspRoutes(cloud: NetNode, nodes: NetNode[], edges: NetEdge[]): IspRoute[] {
  const routes: IspRoute[] = []
  for (const n of nodes) {
    if (!['router', 'gateway'].includes(n.data.deviceType) || !n.data.ip || !isIpv4(n.data.ip) || isPrivateIp(n.data.ip)) continue
    const path = findPath(cloud.id, n.id, nodes, edges)
    if (!path || path.length < 2 || !NEXT_HOP_TYPES.includes(nodeById(path[1], nodes)?.data.deviceType ?? '')) continue
    const hops = hopsOn(path.slice(1), nodes)
    if (!hops.length) continue
    const lan = lanNetwork(n)
    if (routes.some((r) => r.destination === lan.destination && r.subnet === lan.subnet)) continue
    routes.push({ id: `isp-${n.id}`, ...lan, nextHop: preferredHop(n, hops) })
  }
  return routes
}

const isMask = (m: string) => {
  if (!isIpv4(m)) return false
  const n = ipToInt(m)
  return ((~n >>> 0) & ((~n >>> 0) + 1)) === 0   // ones then zeros
}

/** Parse "203.0.113.0/24" (or a lone address, taken as /32). */
export function parsePrefix(s: string): { destination: string; subnet: string } | null {
  const [addr, bits] = s.trim().split('/')
  if (!addr || !isIpv4(addr)) return null
  const cidr = bits === undefined ? 32 : Number(bits)
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) return null
  const subnet = cidr === 0 ? '0.0.0.0' : [24, 16, 8, 0].map((s) => ((0xffffffff << (32 - cidr)) >>> s) & 255).join('.')
  return { destination: addr, subnet }
}

/** Why an ISP route can't be added, or null. */
export function validateIspRoute(r: { destination: string; subnet: string; nextHop: string }, nodes: NetNode[]): string | null {
  if (!isIpv4(r.destination) || !isMask(r.subnet)) return 'Write the network as an address and prefix length, e.g. 203.0.113.0/24.'
  const { network } = networkRange(r.destination, r.subnet)
  if (network !== r.destination) return `${r.destination} isn't the start of a network: use ${network}/${subnetToCidr(r.subnet)}.`
  if (r.subnet === '0.0.0.0') return "A route for every address (/0) isn't something an ISP announces for one customer."
  if (isPrivateIp(r.destination)) {
    return `${routePrefix(r)} is private (${privateRange(r.destination)}): every network reuses those addresses, so ISPs never carry them.`
  }
  if (!isIpv4(r.nextHop)) return "The next hop is the router's WAN address, e.g. 198.51.100.1."
  const hop = nodes.find((n) => NEXT_HOP_TYPES.includes(n.data.deviceType) && outsideAddress(n) === r.nextHop)
  if (!hop) return `No router, gateway or firewall has the WAN address ${r.nextHop}.`
  return null
}

/** A route's next hop with the device's name, e.g. `198.51.100.1 (CareConnect Router)`. */
export function nextHopLabel(nextHop: string, nodes: NetNode[]): string {
  const hop = nodes.find((n) => NEXT_HOP_TYPES.includes(n.data.deviceType) && outsideAddress(n) === nextHop)
  return hop ? `${nextHop} (${hop.data.label})` : nextHop
}

/** The network to name in a note, and the next hop to suggest: the LAN of the router `ip` is behind. */
function suggestion(hops: NetNode[], ip: string): { prefix: string; hop: string; owner: NetNode } {
  const owner = [...hops].reverse().find((n) => ['router', 'gateway'].includes(n.data.deviceType) && n.data.ip && isIpv4(n.data.ip)
    && sameSubnet(n.data.ip, ip, n.data.subnet || '255.255.255.0'))
  if (owner) return { prefix: routePrefix(lanNetwork(owner)), hop: preferredHop(owner, hops), owner }
  const last = hops[hops.length - 1]!
  return { prefix: `${ip}/32`, hop: outsideAddress(last), owner: last }
}

export type IspMiss = { direction: 'to' | 'back'; explain: string }

/**
 * Check the ISP's routes for a path through the Internet node at `path[ci]`: to the destination, and
 * back to the sender (a private sender is answered at its NAT gateway's WAN address, always reachable).
 */
export function ispCheck(path: string[], ci: number, srcIp: string, dstIp: string, dstLabel: string, nodes: NetNode[]): IspMiss | null {
  const cloud = nodeById(path[ci], nodes)
  const routes = cloud?.data.ispRoutes
  if (!cloud || !Array.isArray(routes)) return null

  /** `side`: the path from the Internet node towards the address (Internet node excluded). */
  const miss = (side: string[], ip: string): string | null => {
    // Plugged straight into the Internet node: on the ISP's own network
    if (!NEXT_HOP_TYPES.includes(nodeById(side[0], nodes)?.data.deviceType ?? '')) return null
    const hops = hopsOn(side, nodes)
    if (!hops.length || hops.some((h) => outsideAddress(h) === ip)) return null   // a WAN address: on the ISP's network
    const route = ispRouteFor(routes, ip)
    const { prefix, hop, owner } = suggestion(hops, ip)
    if (!route) {
      return `no ISP has a route for ${prefix}, the network behind ${owner.data.label}. A public address is only reachable once its network is announced: add ${prefix} → ${hop} in the Internet node's Routing tab, or press Announce on ${owner.data.label}'s Routing tab.`
    }
    if (!hops.some((h) => outsideAddress(h) === route.nextHop)) {
      return `the ISP's route for ${routePrefix(route)} sends it to ${nextHopLabel(route.nextHop, nodes)}, but ${ip} is behind ${owner.data.label} (${hop}), so it never gets there. Fix the next hop in the Internet node's Routing tab.`
    }
    return null
  }

  const to = miss(path.slice(ci + 1), dstIp)
  if (to) return { direction: 'to', explain: `ⓘ The internet has no route to ${dstIp}: ${to}` }

  const back = srcIp && !isPrivateIp(srcIp) ? miss(path.slice(0, ci).reverse(), srcIp) : null
  if (back) return { direction: 'back', explain: `ⓘ ${dstLabel} received the request but can't send the reply: the internet has no route back to ${srcIp} — ${back}` }
  return null
}
