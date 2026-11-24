import type { TerminalLine, PacketAnim, PendingCapture } from '../types'
import { nodeById, simulatePingRtt, subnetToCidr } from './network'
import { type TermContext, type Lines, out, err, info, self, delayLines } from './context'
import { HOP_MS, scaledHop, leg, makePacketsWithArp, finishMs, startAfter, firstHopMacs } from './packets'
import { resolveTarget, isResolveError, isIp, dnsServerIpOf, routeTo, nodeForIp, type Resolution } from './resolve'
import { playLookup } from './lookup'
import { errnoText, findSegmentPath, isRoutingHop, INTERNET_HOPS, type Route } from './routing'
import { playUnreachable } from './unreachable'
import { tokenize } from './tokenize'
import { runConversations, hostKeyFingerprint, newConversation, tcpOpen, tcpRefused } from './exchange'
import { cmdCurl } from './protocols/web'
import { cmdFtp, cmdSftp, sshHandshake, sshEncrypted } from './protocols/files'
import { cmdPop3, cmdImap, cmdSmtp, cmdMail } from './protocols/mail'
import { cmdSs, cmdNetstat } from './protocols/ports'
import { isListening, servicesFor } from './services'

export type { TermContext } from './context'
export { makePackets, makePacketsWithArp, edgesOnPath, finishMs, startAfter } from './packets'
export { PUBLIC_IPS } from './resolve'

/**
 * Animate the DNS query and answer for a resolution, if a DNS server was asked.
 * Returns when the answer arrives (ms), so later packets and lines can wait for it.
 */
function animateDns(r: Resolution, ctx: TermContext): number {
  return playLookup(r, ctx).endMs
}

/** The error line for a name that didn't resolve, and why when the address rules are the reason. */
function resolveErrorLines(cmd: string, r: Resolution & { error: string; explain?: string }, at: number): Lines {
  return [err(resolveErrorText(cmd, r), at), ...(r.explain ? [info(r.explain, at)] : [])]
}

/** The terminal error for a name that didn't resolve. */
function resolveErrorText(cmd: string, r: Resolution & { error: string }): string {
  switch (r.error) {
    case 'nxdomain': return `${cmd}: cannot resolve ${r.name}: Unknown host`
    case 'no-dns':   return `${cmd}: ${r.name}: Name or service not known`
    case 'timeout':  return `${cmd}: ${r.name}: Temporary failure in name resolution`
    default:         return `${cmd}: sendmsg: No route to host`
  }
}

// ─── Command implementations ───────────────────────────────────────────────

function cmdPing(args: string[], ctx: TermContext): Lines {
  const target = args[0]
  if (!target) return [err('Usage: ping <ip or hostname>')]

  const src = self(ctx)
  const r = resolveTarget(target, ctx)
  // The client can't address a packet it hasn't resolved yet: ICMP waits for the DNS answer
  const afterDns = animateDns(r, ctx)
  const lines: Lines = r.dnsServerIp ? [info(`Resolving ${target} via DNS (${r.dnsServerIp})…`)] : []

  if (isResolveError(r)) return [...lines, ...resolveErrorLines('ping', r, afterDns)]
  const header = isIp(target) ? `PING ${target}: 56 data bytes` : `PING ${target} (${r.ip}): 56 data bytes`
  const dst = r.node
  const route = routeTo(dst, r.ip, ctx)
  if (!route.ok) return [...lines, ...pingFailure(route, target, r.ip, header, src.data.ip, ctx, afterDns)]
  if (!dst) return [...lines, err('ping: sendmsg: No route to host', afterDns)]
  const path = route.path
  if (!dst.data.isOn) {
    return [...lines, out(header, afterDns), err('Request timeout for icmp_seq 0', afterDns)]
  }

  const icmpPackets = startAfter(makePacketsWithArp(src, dst, path, ctx, 'ICMP', 'ICMP', true), afterDns)
  ctx.dispatchPackets?.(icmpPackets)

  const hops = path.length - 1
  const internet = dst.data.deviceType === 'cloud'

  // Capture: four echo request/reply pairs; the first is the one animated
  const roundTrip = 2 * hops * scaledHop(HOP_MS)
  const echoStart = finishMs(icmpPackets) - roundTrip
  const out1 = firstHopMacs(path, ctx.nodes)
  const back1 = firstHopMacs([...path].reverse(), ctx.nodes)
  const convId = `icmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const icmpBase = { conversationId: convId, transport: 'ICMP' as const, app: 'ICMP' as const, encrypted: false, length: 84 }
  const captures: PendingCapture[] = []
  for (let i = 0; i < 4; i++) {
    const t = echoStart + i * Math.max(roundTrip, 1)
    captures.push(
      { ...icmpBase, stepIndex: 2 * i, delayMs: t, srcIp: src.data.ip, dstIp: r.ip, ...out1, route: path,
        info: `Echo (ping) request  id=0x0001, seq=${i}, ttl=64` },
      { ...icmpBase, stepIndex: 2 * i + 1, delayMs: t + roundTrip / 2, srcIp: r.ip, dstIp: src.data.ip, ...back1, route: [...path].reverse(),
        info: `Echo (ping) reply    id=0x0001, seq=${i}, ttl=${internet ? 52 : 64 - hops}` },
    )
  }
  ctx.dispatchCaptures?.(captures)
  const body: Lines = [out(header)]
  const rtts: number[] = []
  for (let i = 0; i < 4; i++) {
    const rtt = internet ? 20 + hops * 8 + Math.floor(Math.random() * 15) : simulatePingRtt(hops)
    rtts.push(rtt)
    body.push(out(`64 bytes from ${r.ip}: icmp_seq=${i} ttl=${internet ? 52 : 64 - hops} time=${rtt} ms`))
  }
  const min = Math.min(...rtts), max = Math.max(...rtts)
  const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)
  body.push(
    out(''),
    out(`--- ${target} ping statistics ---`),
    out('4 packets transmitted, 4 packets received, 0.0% packet loss'),
    out(`round-trip min/avg/max = ${min}/${avg}/${max} ms`),
  )
  return [...lines, ...delayLines(body, afterDns)]
}

/** What ping prints when the address rules stop it, with the packets that do go out. */
function pingFailure(route: Extract<Route, { ok: false }>, target: string, ip: string, header: string, srcIp: string, ctx: TermContext, startMs: number): Lines {
  const stats = (sent: number) => [out(''), out(`--- ${target} ping statistics ---`), out(`${sent} packets transmitted, 0 packets received, 100.0% packet loss`)]
  const explain = route.explain ? [info(route.explain)] : []
  let body: Lines
  switch (route.failure) {
    case 'no-address':
    case 'net-unreachable':
      body = [err('ping: sendto: Network is unreachable'), ...explain]
      break
    case 'host-unreachable':
      // ARP for the next hop got no answer
      body = [out(header), ...[0, 1, 2].map((i) => err(`From ${srcIp} icmp_seq=${i} Destination Host Unreachable`)), ...stats(3), ...explain]
      break
    case 'private':
    case 'not-on-network':
    case 'no-reply':
      body = [out(header), ...[0, 1, 2, 3].map((i) => out(`Request timeout for icmp_seq ${i}`)), ...stats(4), ...explain]
      break
    default:
      body = [err('ping: sendmsg: No route to host'), ...explain]
  }
  return playUnreachable(route, { kind: 'icmp' }, ip, ctx, body, startMs).lines
}

/**
 * traceroute's lines for `path`: one per device that routes (each one lowers the TTL, so each one
 * answers a probe), addressed by the interface the probe arrived on; the Internet node as its backbone
 * routers. Switches, hubs and access points never appear. With `dst`, the last line is the destination;
 * without it the probes die at the end of `path` (and an Internet node there drops them at the ISP).
 */
function tracerouteHops(path: string[], ctx: TermContext, dst?: { ip: string; label: string }): Lines {
  const lines: Lines = []
  let n = 0
  let pastInternet = false
  const hop = (ip: string, label: string) => {
    n++
    const rtt = pastInternet ? 15 + n * 4 + Math.floor(Math.random() * 4) : simulatePingRtt(n)
    lines.push(out(` ${n}  ${ip} (${label})  ${rtt} ms  ${rtt + 1} ms  ${rtt} ms`))
  }
  for (let i = 1; i < path.length; i++) {
    const node = nodeById(path[i]!, ctx.nodes)
    if (!node) continue
    const last = i === path.length - 1
    if (node.data.deviceType === 'cloud') {
      const backbone = last && !dst ? INTERNET_HOPS.slice(0, 1) : INTERNET_HOPS
      backbone.forEach((h) => hop(h.ip, h.label))
      pastInternet = true
      if (last && dst) hop(dst.ip, dst.label)
      continue
    }
    if (last && dst) { hop(dst.ip, node.data.label); continue }
    if (!isRoutingHop(path, i, ctx.nodes)) continue
    const prev = nodeById(path[i - 1]!, ctx.nodes)
    const fromWan = ['router', 'gateway', 'cloud', 'firewall'].includes(prev?.data.deviceType ?? '')
    hop((fromWan && node.data.wanIp) ? node.data.wanIp : (node.data.ip || '*'), node.data.label)
  }
  return lines
}

function cmdTraceroute(args: string[], ctx: TermContext): Lines {
  const target = args[0]
  if (!target) return [err('Usage: traceroute <ip or hostname>')]

  const src = self(ctx)
  const r = resolveTarget(target, ctx)
  const afterDns = animateDns(r, ctx)
  const lines: Lines = r.dnsServerIp ? [info(`Resolving ${target} via DNS (${r.dnsServerIp})…`)] : []

  if (isResolveError(r)) return [...lines, ...resolveErrorLines('traceroute', r, afterDns)]
  const dst = r.node
  const header = out(`traceroute to ${target} (${r.ip}), 30 hops max, 60 byte packets`)
  const route = routeTo(dst, r.ip, ctx)
  if (!route.ok) {
    const explain = route.explain ? [info(route.explain)] : []
    const silent = (from: number) => [0, 1, 2].map((i) => out(` ${from + i}  * * *`))
    let body: Lines
    if (route.failure === 'no-address' || route.failure === 'net-unreachable') {
      body = [err('traceroute: sendto: Network is unreachable'), ...explain]
    } else if ((route.failure === 'private' || route.failure === 'not-on-network' || route.failure === 'no-reply') && route.reach) {
      // The devices on the way still answer; after that, silence
      const answered = route.failure === 'no-reply' ? route.reach.slice(0, -1) : route.reach
      const hops = tracerouteHops(answered, ctx)
      body = [header, ...hops, ...silent(hops.length + 1), ...explain]
    } else {
      body = [header, ...silent(1), ...explain]
    }
    return [...lines, ...playUnreachable(route, { kind: 'icmp' }, r.ip, ctx, body, afterDns).lines]
  }
  if (!dst) return [...lines, err(`traceroute to ${target}: no route to host`, afterDns)]
  const path = route.path

  ctx.dispatchPackets?.(startAfter(makePacketsWithArp(src, dst, path, ctx, 'ICMP', 'ICMP'), afterDns))

  const label = dst.data.deviceType === 'cloud' ? target : dst.data.label
  const body: Lines = [header, ...tracerouteHops(path, ctx, { ip: r.ip, label })]
  return [...lines, ...delayLines(body, afterDns)]
}

function cmdIpconfig(args: string[], ctx: TermContext): Lines {
  if (args[0] === '/renew') return cmdDhclient([], ctx)
  const node = self(ctx)
  const { ip, wanIp, subnet, gateway, mac } = node.data
  const cidr = subnet ? subnetToCidr(subnet) : 24
  const isRouterType = node.data.deviceType === 'router' || node.data.deviceType === 'gateway'
  if (isRouterType && wanIp) {
    return [
      out(`Ethernet adapter eth0 (WAN):`),
      out(`   IPv4 Address . . . . : ${wanIp}`),
      out(`   Subnet Mask  . . . . : 255.255.255.252 (/30)`),
      out(`   Default Gateway  . . : (ISP)`),
      out(''),
      out(`Ethernet adapter eth1 (LAN):`),
      out(`   IPv4 Address . . . . : ${ip || '(not set)'}`),
      out(`   Subnet Mask  . . . . : ${subnet || '255.255.255.0'} (/${cidr})`),
      out(`   Physical Address . . : ${mac}`),
    ]
  }
  return [
    out(`Ethernet adapter ${node.data.label}:`),
    out(`   IPv4 Address . . . . : ${ip || '(not set)'}`),
    out(`   Subnet Mask  . . . . : ${subnet || '255.255.255.0'} (/${cidr})`),
    out(`   Default Gateway  . . : ${gateway || '(not set)'}`),
    out(`   Physical Address . . : ${mac}`),
  ]
}

function cmdIfconfig(_args: string[], ctx: TermContext): Lines {
  const node = self(ctx)
  const { ip, wanIp, subnet, gateway, mac } = node.data
  const cidr = subnet ? subnetToCidr(subnet) : 24
  const isRouterType = node.data.deviceType === 'router' || node.data.deviceType === 'gateway'
  if (isRouterType && wanIp) {
    return [
      out(`eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`),
      out(`        inet ${wanIp}  netmask 255.255.255.252  broadcast ${wanIp.replace(/\d+$/, '255')}`),
      out(`        ether ${mac}  txqueuelen 1000  (Ethernet)  [WAN]`),
      out(''),
      out(`eth1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`),
      out(`        inet ${ip || '0.0.0.0'}  netmask ${subnet || '255.255.255.0'}  broadcast ${ip?.replace(/\d+$/, '255') ?? ''}`),
      out(`        ether ${mac}  txqueuelen 1000  (Ethernet)  [LAN]`),
      out(`        Gateway: ${gateway || '(ISP)'} (/${cidr})`),
    ]
  }
  return [
    out(`eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`),
    out(`        inet ${ip || '0.0.0.0'}  netmask ${subnet || '255.255.255.0'}  broadcast ${ip?.replace(/\d+$/, '255') ?? ''}`),
    out(`        inet6 fe80::1  prefixlen 64  scopeid 0x20<link>`),
    out(`        ether ${mac}  txqueuelen 1000  (Ethernet)`),
    out(`        Gateway: ${gateway || '(not set)'} (/${cidr})`),
  ]
}

function cmdNslookup(args: string[], ctx: TermContext): Lines {
  const domain = args[0]
  if (!domain) return [err('Usage: nslookup <domain>')]
  const timedOut = (r: Resolution & { explain?: string }, at: number): Lines => [
    err(';; connection timed out; no servers could be reached', at),
    ...(r.explain ? [info(r.explain, at)] : []),
  ]

  if (isIp(domain)) {
    // Reverse lookup needs PTR records, which Networx's DNS server doesn't hold
    const serverIp = dnsServerIpOf(ctx)
    if (!serverIp) return [out('Server:   (none)'), out(''), err(';; connection timed out; no servers could be reached')]
    const arpa = `${domain.split('.').reverse().join('.')}.in-addr.arpa`
    return [
      out(`Server:   ${serverIp}`),
      out(`Address:  ${serverIp}#53`),
      out(''),
      out(`** server can't find ${arpa}: NXDOMAIN`),
    ]
  }

  const r = resolveTarget(domain, ctx)
  if (isResolveError(r) && r.error === 'no-dns') {
    return [out('Server:   (none)'), out(''), ...timedOut(r, 0)]
  }
  if (isResolveError(r) && r.error === 'timeout') {
    // The query went out three times and nothing came back
    return playLookup(r, ctx, timedOut(r, 0)).lines
  }
  const afterDns = animateDns(r, ctx)

  const lines: Lines = [
    out(`Server:   ${r.dnsServerIp}`),
    out(`Address:  ${r.dnsServerIp}#53`),
    out(''),
  ]
  if (isResolveError(r)) {
    lines.push(out(`** server can't find ${domain}: NXDOMAIN`))
  } else {
    if (!r.authoritative) lines.push(out('Non-authoritative answer:'))
    lines.push(out(`Name:     ${domain}`), out(`Address:  ${r.ip}`))
  }
  return delayLines(lines, afterDns)
}

function cmdArp(args: string[], ctx: TermContext): Lines {
  const node = self(ctx)
  if (args[0] === '-d') {
    const ip = args[1]
    const entries = node.data.arpTable ?? []
    if (!ip || ip === '*') {
      ctx.updateNodeData?.(node.id, { arpTable: [] })
      return [info('ARP cache cleared.')]
    }
    if (!entries.some((entry) => entry.ip === ip)) {
      return [err(`arp: ${ip}: no matching entry`)]
    }
    ctx.updateNodeData?.(node.id, {
      arpTable: entries.filter((entry) => entry.ip !== ip),
    })
    return [info(`Deleted ARP entry for ${ip}.`)]
  }

  const lines: Lines = [out('Address         HWtype  HWaddress           Flags Iface')]
  for (const entry of node.data.arpTable ?? []) {
    lines.push(out(`${entry.ip.padEnd(16)}ether   ${entry.mac}  C     ${entry.iface}`))
  }
  if (lines.length === 1) lines.push(out('(no entries)'))
  return lines
}

function cmdRoute(_args: string[], ctx: TermContext): Lines {
  const node = self(ctx)
  const lines: Lines = [
    out('Kernel IP routing table'),
    out('Destination   Gateway       Genmask         Flags Metric Ref  Use Iface'),
  ]
  if (node.data.routingTable.length > 0) {
    node.data.routingTable.forEach((r) => {
      lines.push(out(`${r.destination.padEnd(14)}${r.gateway.padEnd(14)}${r.subnet.padEnd(16)}UG    ${r.metric}      0        0 ${r.iface}`))
    })
  } else {
    lines.push(out(`0.0.0.0       ${node.data.gateway || '0.0.0.0'}       0.0.0.0         UG    0      0        0 eth0`))
    lines.push(out(`192.168.1.0   0.0.0.0       255.255.255.0   U     0      0        0 eth0`))
  }
  return lines
}

function cmdSsh(args: string[], ctx: TermContext): Lines {
  const target = args[0]
  if (!target) return [err('Usage: ssh <ip-address>')]
  const dst = nodeForIp(target, ctx)
  const src = self(ctx)
  const route = routeTo(dst, target, ctx)
  if (!route.ok) {
    const lines = [err(`ssh: connect to host ${target} port 22: ${errnoText(route.failure)}`), ...(route.explain ? [info(route.explain)] : [])]
    return playUnreachable(route, { kind: 'tcp', port: 22 }, target, ctx, lines).lines
  }
  if (!dst || dst.data.deviceType === 'cloud') return [err(`ssh: connect to host ${target} port 22: No route to host`)]
  const path = route.path
  // Servers run SSH as a service (Services tab); clients and routers accept it as before
  const sshAsService = servicesFor(dst.data.deviceType).some((s) => s.id === 'ssh')
  const accepts = sshAsService
    ? isListening(dst, 'ssh')
    : ['pc', 'laptop', 'router', 'gateway'].includes(dst.data.deviceType)
  if (!accepts) {
    const refused = tcpRefused()
    refused[1]!.lines = [err(`ssh: connect to host ${target} port 22: Connection refused`)]
    return runConversations([{ conv: newConversation(src.id, dst.id, target, 22, refused), path }], ctx).lines
  }

  // TCP to port 22, banners and key exchange in the clear, then everything encrypted
  const open = tcpOpen()
  open[0]!.lines = [out(`Connecting to ${target} (${dst.data.label})...`)]
  const steps = [
    ...open,
    ...sshHandshake(target, target, hostKeyFingerprint(dst.id)),
    sshEncrypted('c2s', '🔒 auth', 'User authentication: user name and password'),
    sshEncrypted('s2c', '🔒 OK', 'Authentication successful'),
    sshEncrypted('c2s', '🔒 shell', 'Open a session channel and start a shell'),
    sshEncrypted('s2c', '🔒 shell', 'Channel open: shell started', [
      info(`Connected to ${dst.data.label} (${target}). Type 'exit' to disconnect.`),
      // Signal to Terminal component to enter SSH session mode
      { type: 'output' as const, text: `\x1bSSH:${dst.id}` },
    ]),
  ]
  return runConversations([{ conv: newConversation(src.id, dst.id, target, 22, steps), path }], ctx).lines
}

/** DHCP's ports: the server listens on UDP 67, the client on UDP 68. */
export const DHCP_SERVER_PORT = 67
export const DHCP_CLIENT_PORT = 68
const LEASE_SECONDS = 86400

function cmdDhclient(_args: string[], ctx: TermContext): Lines {
  const src = self(ctx)

  // Find DHCP-enabled routers/gateways reachable from this node
  const dhcpRouters = ctx.nodes.filter(
    (n) => (n.data.deviceType === 'router' || n.data.deviceType === 'gateway') && n.data.dhcpEnabled,
  )

  for (const router of dhcpRouters) {
    // DISCOVER is a broadcast: only a DHCP server on the same network segment hears it
    const path = findSegmentPath(src.id, router.id, ctx.nodes, ctx.edges)
    if (!path) continue

    // Parse pool range (last-octet format "100-200")
    const routerIpParts = router.data.ip.split('.')
    const prefix = routerIpParts.slice(0, 3).join('.')
    const pool = (router.data.dhcpPool as string | undefined) || '100-200'
    const [startStr, endStr] = pool.split('-')
    const startLast = parseInt(startStr ?? '100', 10)
    const endLast   = endStr ? parseInt(endStr, 10) : 200

    // Find next unused IP from pool
    const usedIps = new Set(ctx.nodes.map((n) => n.data.ip).filter(Boolean))
    let assignedIp: string | null = null
    for (let i = startLast; i <= endLast; i++) {
      const candidate = `${prefix}.${i}`
      if (!usedIps.has(candidate)) { assignedIp = candidate; break }
    }

    if (!assignedIp) {
      return [err('dhclient: No IPs available in DHCP pool — all addresses in use.')]
    }

    // 4-way DHCP exchange: DISCOVER → OFFER → REQUEST → ACK, over UDP 68 ⇄ 67
    const legMs = (path.length - 1) * scaledHop(HOP_MS)
    const dhcpPackets: PacketAnim[] = [
      ...leg(path, ctx.edges, 'UDP', 'DISCOVER', 0),               // client → router
      ...leg(path, ctx.edges, 'UDP', 'OFFER',    legMs, true),     // router → client
      ...leg(path, ctx.edges, 'UDP', 'REQUEST',  2 * legMs),       // client → router
      ...leg(path, ctx.edges, 'UDP', 'ACK',      3 * legMs, true), // router → client
    ]
    ctx.dispatchPackets?.(dhcpPackets)
    ctx.dispatchCaptures?.(dhcpCaptures(src.data.mac, router, assignedIp, `${prefix}.1`, path, ctx, legMs))

    // Update the node's IP address when the ACK arrives
    const ackMs = 4 * legMs
    const apply = () => ctx.updateNodeData?.(src.id, {
      ip: assignedIp,
      gateway: `${prefix}.1`,
      subnet: '255.255.255.0',
    })
    if (ctx.schedule) ctx.schedule(ackMs, apply)
    else apply()

    return [
      info('DHCP DISCOVER sent (broadcast)…'),
      { ...info(`DHCP OFFER received from ${router.data.ip}: ${assignedIp}`), delayMs: 2 * legMs },
      { ...info('DHCP REQUEST sent…'), delayMs: 2 * legMs },
      { ...info(`DHCP ACK — lease granted.`), delayMs: ackMs },
      { ...out(''), delayMs: ackMs },
      { ...out(`inet ${assignedIp}/24 brd ${prefix}.255 scope global dynamic eth0`), delayMs: ackMs },
      { ...out(`   valid_lft ${LEASE_SECONDS}sec preferred_lft ${LEASE_SECONDS}sec`), delayMs: ackMs },
      { ...info('ⓘ DHCP runs over UDP: the client sends from port 68 to port 67. It has no address yet, so it sends from 0.0.0.0 to the broadcast address 255.255.255.255.'), delayMs: ackMs },
    ]
  }

  return [err('dhclient: No DHCP server found. Is a router with DHCP enabled connected to this network?')]
}

/**
 * Capture records for DISCOVER, OFFER, REQUEST, ACK. The client has no address yet, so it sends
 * from 0.0.0.0 to 255.255.255.255 (and MAC ff:ff:ff:ff:ff:ff); the server answers the offered address.
 */
function dhcpCaptures(
  clientMac: string,
  router: { data: { ip: string; mac: string } },
  offered: string,
  gateway: string,
  path: string[],
  ctx: TermContext,
  legMs: number,
): PendingCapture[] {
  const xid = `0x${(parseInt(clientMac.replace(/[^0-9a-f]/gi, '').slice(-8) || '1', 16) >>> 0).toString(16).padStart(8, '0')}`
  const toClient = firstHopMacs([...path].reverse(), ctx.nodes)
  const conversationId = `dhcp-${Date.now().toString(36)}`
  const base = { conversationId, transport: 'UDP' as const, app: 'DHCP' as const, encrypted: false }
  const length = (payload: string) => new TextEncoder().encode(payload).length + 20 + 8
  const rec = (i: number, c2s: boolean, kind: string, payload: string): PendingCapture => ({
    ...base,
    delayMs: i * legMs,
    stepIndex: i,
    route: c2s ? path : [...path].reverse(),
    srcIp: c2s ? '0.0.0.0' : router.data.ip,
    srcPort: c2s ? DHCP_CLIENT_PORT : DHCP_SERVER_PORT,
    dstIp: c2s ? '255.255.255.255' : offered,
    dstPort: c2s ? DHCP_SERVER_PORT : DHCP_CLIENT_PORT,
    srcMac: c2s ? clientMac : toClient.srcMac,
    dstMac: c2s ? 'ff:ff:ff:ff:ff:ff' : clientMac,
    info: `DHCP ${kind} - Transaction ID ${xid}`,
    payload,
    length: length(payload),
  })
  return [
    rec(0, true, 'Discover', `DHCP Discover\n  client MAC: ${clientMac}\n  asks: any DHCP server, please offer me an address`),
    rec(1, false, 'Offer', `DHCP Offer\n  your address: ${offered}\n  subnet mask: 255.255.255.0\n  router (default gateway): ${gateway}\n  lease time: ${LEASE_SECONDS} s\n  DHCP server: ${router.data.ip}`),
    rec(2, true, 'Request', `DHCP Request\n  requested address: ${offered}\n  DHCP server: ${router.data.ip}`),
    rec(3, false, 'ACK', `DHCP ACK\n  your address: ${offered}\n  lease time: ${LEASE_SECONDS} s`),
  ]
}

function cmdHelp(): Lines {
  return [
    out('Connectivity'),
    out('  ping <ip|host>                 Test connectivity'),
    out('  traceroute <ip|host>           Trace the path to a host'),
    out('  ipconfig / ifconfig            Show IP configuration'),
    out('  arp -a | arp -d [ip|*]         Show / delete ARP entries'),
    out('  route                          Show routing table'),
    out('  dhclient / ipconfig /renew     Get an IP address by DHCP'),
    out('Name lookup'),
    out('  nslookup <name>                Ask the DNS server for an address'),
    out('Web'),
    out('  curl [-v] http(s)://<host>     Fetch a page (-v shows every step)'),
    out('       -I  headers only     -k  carry on past a bad certificate'),
    out('Files'),
    out('  ftp <host> [ls | get <file>]   FTP: ports 21 and 20, unencrypted'),
    out('  sftp <host> [ls | get <file>]  SFTP: inside SSH on port 22, encrypted'),
    out('Mail'),
    out('  smtp <from> <to> "<subject>"   Send a message (port 587)'),
    out('  pop3 <address> [--keep]        Download mail to this device (port 110)'),
    out('  imap <address> [read <n>]      Read mail kept on the server (port 143)'),
    out('  mail [n]                       Read mail downloaded to this device'),
    out('    add --tls to smtp, pop3 or imap for the TLS ports (465, 995, 993)'),
    out('Ports'),
    out('  ss  (or netstat -tuln)         Ports this device is listening on'),
    out('  netstat                        This device\'s recent connections'),
    out('Remote'),
    out('  ssh <ip>                       Log in to another device (exit to leave)'),
    out('Other'),
    out('  clear                          Clear the terminal'),
    out('  help                           Show this help'),
  ]
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export function runCommand(raw: string, baseCtx: TermContext): TerminalLine[] {
  const ctx: TermContext = { ...baseCtx, arpSeen: new Set() }
  const parts = tokenize(raw)
  const cmd = parts[0]?.toLowerCase() ?? ''
  const args = parts.slice(1)

  switch (cmd) {
    case 'ping': return cmdPing(args, ctx)
    case 'traceroute':
    case 'tracert': return cmdTraceroute(args, ctx)
    case 'ipconfig': return cmdIpconfig(args, ctx)
    case 'ifconfig': return cmdIfconfig(args, ctx)
    case 'nslookup': return cmdNslookup(args, ctx)
    case 'arp': return cmdArp(args, ctx)
    case 'netstat': return cmdNetstat(args, ctx)
    case 'ss': return cmdSs(args, ctx)
    case 'route': return cmdRoute(args, ctx)
    case 'curl':
    case 'wget': return cmdCurl(args, ctx)
    case 'pop3': return cmdPop3(args, ctx)
    case 'imap': return cmdImap(args, ctx)
    case 'smtp': return cmdSmtp(args, ctx)
    case 'mail': return cmdMail(args, ctx)
    case 'ftp': return cmdFtp(args, ctx)
    case 'sftp': return cmdSftp(args, ctx)
    case 'ssh': return cmdSsh(args, ctx)
    case 'dhclient': return cmdDhclient(args, ctx)
    case 'clear': return [{ type: 'output', text: '\x1bCLEAR' }]
    case 'help': return cmdHelp()
    case '': return []
    default: return [err(`command not found: ${cmd}`)]
  }
}
