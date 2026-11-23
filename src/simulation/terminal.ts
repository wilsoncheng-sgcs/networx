import type { TerminalLine, PacketAnim } from '../types'
import { findPath, nodeById, nodeByIp, simulatePingRtt, subnetToCidr } from './network'
import { type TermContext, type Lines, out, err, info, self, delayLines } from './context'
import { HOP_MS, scaledHop, leg, makePacketsWithArp, finishMs, startAfter } from './packets'
import { resolveTarget, isResolveError, isIp, dnsServerFor, type Resolution } from './resolve'
import { tokenize } from './tokenize'
import { dnsConversation, runConversations } from './exchange'

export type { TermContext } from './context'
export { makePackets, makePacketsWithArp, edgesOnPath, finishMs, startAfter } from './packets'
export { PUBLIC_IPS } from './resolve'

/**
 * Animate the DNS query and answer for a resolution, if a DNS server was asked.
 * Returns when the answer arrives (ms), so later packets and lines can wait for it.
 */
function animateDns(r: Resolution, ctx: TermContext): number {
  const dnsLeg = dnsConversation(r, ctx)
  return dnsLeg ? runConversations([dnsLeg], ctx).endMs : 0
}

/** The terminal error for a name that didn't resolve. */
function resolveErrorText(cmd: string, r: Resolution & { error: string }): string {
  switch (r.error) {
    case 'nxdomain': return `${cmd}: cannot resolve ${r.name}: Unknown host`
    case 'no-dns':   return `${cmd}: ${r.name}: Name or service not known`
    default:         return `${cmd}: sendmsg: No route to host`
  }
}

// Simulated internet backbone hops shown in traceroute
const INTERNET_HOPS = [
  { ip: '195.68.128.1',  label: 'ISP Gateway'       },
  { ip: '62.115.52.22',  label: 'Backbone router'    },
  { ip: '108.170.252.1', label: 'Exchange point'     },
]

// ─── Command implementations ───────────────────────────────────────────────

function cmdPing(args: string[], ctx: TermContext): Lines {
  const target = args[0]
  if (!target) return [err('Usage: ping <ip or hostname>')]

  const src = self(ctx)
  const r = resolveTarget(target, ctx)
  // The client can't address a packet it hasn't resolved yet: ICMP waits for the DNS answer
  const afterDns = animateDns(r, ctx)
  const lines: Lines = r.dnsServerIp ? [info(`Resolving ${target} via DNS (${r.dnsServerIp})…`)] : []

  if (isResolveError(r)) return [...lines, err(resolveErrorText('ping', r), afterDns)]
  const dst = r.node
  const path = dst ? findPath(src.id, dst.id, ctx.nodes, ctx.edges) : null
  if (!dst || !path) return [...lines, err('ping: sendmsg: No route to host', afterDns)]

  const header = isIp(target) ? `PING ${target}: 56 data bytes` : `PING ${target} (${r.ip}): 56 data bytes`
  if (!dst.data.isOn) {
    return [...lines, out(header, afterDns), err('Request timeout for icmp_seq 0', afterDns)]
  }

  ctx.dispatchPackets?.(startAfter(makePacketsWithArp(src, dst, path, ctx, 'ICMP', 'ICMP', true), afterDns))

  const hops = path.length - 1
  const internet = dst.data.deviceType === 'cloud'
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

function cmdTraceroute(args: string[], ctx: TermContext): Lines {
  const target = args[0]
  if (!target) return [err('Usage: traceroute <ip or hostname>')]

  const src = self(ctx)
  const r = resolveTarget(target, ctx)
  const afterDns = animateDns(r, ctx)
  const lines: Lines = r.dnsServerIp ? [info(`Resolving ${target} via DNS (${r.dnsServerIp})…`)] : []

  if (isResolveError(r)) return [...lines, err(resolveErrorText('traceroute', r), afterDns)]
  const dst = r.node
  const path = dst ? findPath(src.id, dst.id, ctx.nodes, ctx.edges) : null
  if (!dst || !path) return [...lines, err(`traceroute to ${target}: no route to host`, afterDns)]

  ctx.dispatchPackets?.(startAfter(makePacketsWithArp(src, dst, path, ctx, 'ICMP', 'ICMP'), afterDns))

  const body: Lines = [out(`traceroute to ${target} (${r.ip}), 30 hops max, 60 byte packets`)]
  const WAN_SIDE_TYPES = ['router', 'gateway', 'cloud', 'firewall']
  let hopNum = 1
  path.slice(1).forEach((nodeId, i) => {
    const node = nodeById(nodeId, ctx.nodes)
    const prevNode = nodeById(path[i]!, ctx.nodes)
    const fromWan = WAN_SIDE_TYPES.includes(prevNode?.data.deviceType ?? '')
    const ip = (fromWan && node?.data.wanIp) ? node.data.wanIp : (node?.data.ip || node?.data.label || '*')
    const rtt = simulatePingRtt(i + 1)
    body.push(out(` ${hopNum}  ${ip} (${node?.data.label ?? ''})  ${rtt} ms  ${rtt + 1} ms  ${rtt} ms`))
    hopNum++
  })

  if (dst.data.deviceType === 'cloud') {
    // Simulated internet backbone hops, then the host itself
    INTERNET_HOPS.forEach((hop, i) => {
      const rtt = 15 + hopNum * 4 + i * 3 + Math.floor(Math.random() * 4)
      body.push(out(` ${hopNum}  ${hop.ip} (${hop.label})  ${rtt} ms  ${rtt + 2} ms  ${rtt + 1} ms`))
      hopNum++
    })
    const finalRtt = 30 + Math.floor(Math.random() * 10)
    body.push(out(` ${hopNum}  ${r.ip} (${target})  ${finalRtt} ms  ${finalRtt + 1} ms  ${finalRtt} ms`))
  }
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

  if (isIp(domain)) {
    // Reverse lookup needs PTR records, which Networx's DNS server doesn't hold
    const server = dnsServerFor(ctx)
    if (!server) return [out('Server:   (none)'), out(''), err(';; connection timed out; no servers could be reached')]
    const arpa = `${domain.split('.').reverse().join('.')}.in-addr.arpa`
    return [
      out(`Server:   ${server.ip}`),
      out(`Address:  ${server.ip}#53`),
      out(''),
      out(`** server can't find ${arpa}: NXDOMAIN`),
    ]
  }

  const r = resolveTarget(domain, ctx)
  const afterDns = animateDns(r, ctx)

  if (!r.dnsServerIp) {
    return [out('Server:   (none)'), out(''), err(';; connection timed out; no servers could be reached')]
  }

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

function cmdNetstat(_args: string[], ctx: TermContext): Lines {
  const node = self(ctx)
  const neighbours = ctx.edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => (e.source === node.id ? e.target : e.source))

  const lines: Lines = [
    out('Active Internet connections (w/o servers)'),
    out('Proto Recv-Q Send-Q Local Address           Foreign Address         State'),
  ]
  neighbours.forEach((nid) => {
    const n = nodeById(nid, ctx.nodes)
    if (n?.data.ip) {
      lines.push(out(`tcp        0      0 ${node.data.ip}:${Math.floor(Math.random() * 20000 + 40000)}  ${n.data.ip}:80     ESTABLISHED`))
    }
  })
  if (lines.length === 2) lines.push(out('(no connections)'))
  return lines
}

function cmdCurl(args: string[], ctx: TermContext): Lines {
  const url = args[0]
  if (!url) return [err('Usage: curl <url>')]

  const hostname = url.replace(/^https?:\/\//, '').split('/')[0]
  const src = self(ctx)

  // Check for a local web server first
  const webNode = ctx.nodes.find((n) => n.data.deviceType === 'web')
  const localPath = webNode ? findPath(src.id, webNode.id, ctx.nodes, ctx.edges) : null

  // Helper: render page content as terminal lines
  function renderPage(node: typeof webNode): Lines {
    const content = (node?.data.pageContent || '').trim() || '<h1>Welcome</h1>'
    const bytes = content.length
    return [
      out(`  % Total    % Received % Xferd  Average Speed   Time`),
      out(`100  ${bytes.toString().padStart(4)}  100  ${bytes.toString().padStart(4)}    0     0   5120      0 --:--:-- --:--:--`),
      out(''),
      ...content.split('\n').map((line) => out(line)),
    ]
  }

  // If hostname is an IP address and matches a reachable local web server, serve it
  if (!!isIp(hostname) && localPath && webNode?.data.ip === hostname) {
    ctx.dispatchPackets?.(makePacketsWithArp(src, webNode, localPath, ctx, 'HTTP', 'HTTP', true))
    return renderPage(webNode)
  }

  // If hostname is a domain, try to resolve it via the DNS node's local records
  if (!isIp(hostname)) {
    const dnsNode = ctx.nodes.find((n) => n.data.deviceType === 'dns')
    const dnsPath = dnsNode ? findPath(src.id, dnsNode.id, ctx.nodes, ctx.edges) : null
    const localRecord = dnsPath
      ? (dnsNode!.data.dnsRecords ?? []).find(
          (r) => r.hostname.toLowerCase() === hostname.toLowerCase(),
        )
      : undefined

    if (localRecord) {
      // Resolved locally — find the web server with that IP
      const targetWeb = ctx.nodes.find(
        (n) => n.data.deviceType === 'web' && n.data.ip === localRecord.ip,
      )
      const targetPath = targetWeb ? findPath(src.id, targetWeb.id, ctx.nodes, ctx.edges) : null
      // DNS query and answer first, then the HTTP request to the address it returned
      let afterDns = 0
      if (dnsPath && dnsNode) {
        const dnsPackets = makePacketsWithArp(src, dnsNode, dnsPath, ctx, 'DNS', 'DNS', true)
        afterDns = finishMs(dnsPackets)
        ctx.dispatchPackets?.(dnsPackets)
      }
      if (targetPath && targetWeb) {
        ctx.dispatchPackets?.(startAfter(makePacketsWithArp(src, targetWeb, targetPath, ctx, 'HTTP', 'HTTP', true), afterDns))
        return renderPage(targetWeb)
      }
      return [err(`curl: (7) Failed to connect to ${hostname} (${localRecord.ip}): No route to host`)]
    }
  }

  // External URL — need internet access
  const cloudNode = ctx.nodes.find((n) => n.data.deviceType === 'cloud')
  const canReachInternet = cloudNode && findPath(src.id, cloudNode.id, ctx.nodes, ctx.edges)

  if (!canReachInternet) {
    return [err(`curl: (6) Could not resolve host: ${hostname}`)]
  }

  // If local web server exists and is reachable, use it for any reachable host (fallback)
  if (localPath && !!isIp(hostname)) {
    ctx.dispatchPackets?.(makePacketsWithArp(src, webNode!, localPath, ctx, 'HTTP', 'HTTP', true))
    return renderPage(webNode)
  }

  ctx.dispatchPackets?.(
    makePacketsWithArp(src, cloudNode!, canReachInternet, ctx, 'HTTP', 'HTTP', true),
  )

  return [
    out(`  % Total    % Received % Xferd  Average Speed   Time`),
    out(`100  1256  100  1256    0     0  12560      0 --:--:-- --:--:--`),
    out(''),
    out(`<!DOCTYPE html>`),
    out(`<html><head><title>${hostname}</title></head>`),
    out(`<body>`),
    out(`<h1>Welcome to ${hostname}</h1>`),
    out(`<p>This is a simulated response from the internet.</p>`),
    out(`</body></html>`),
  ]
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
  const dst = nodeByIp(target, ctx.nodes)
  if (!dst) return [err(`ssh: connect to host ${target}: No route to host`)]
  if (!['pc', 'laptop', 'server', 'web', 'dns', 'router', 'gateway'].includes(dst.data.deviceType)) {
    return [err(`ssh: connect to host ${target}: Connection refused`)]
  }
  const src = self(ctx)
  const path = findPath(src.id, dst.id, ctx.nodes, ctx.edges)
  if (!path) return [err(`ssh: connect to host ${target}: Network unreachable`)]
  ctx.dispatchPackets?.(makePacketsWithArp(src, dst, path, ctx, 'TCP', 'SSH'))
  return [
    out(`Connecting to ${target} (${dst.data.label})...`),
    out(`The authenticity of host '${target}' can't be established.`),
    out(`ECDSA key fingerprint is SHA256:${Math.random().toString(36).slice(2, 18).toUpperCase()}.`),
    out(`Warning: Permanently added '${target}' (ECDSA) to the list of known hosts.`),
    info(`Connected to ${dst.data.label} (${target}). Type 'exit' to disconnect.`),
    // Signal to Terminal component to enter SSH session mode
    { type: 'output' as const, text: `\x1bSSH:${dst.id}` },
  ]
}

function cmdDhclient(_args: string[], ctx: TermContext): Lines {
  const src = self(ctx)

  // Find DHCP-enabled routers/gateways reachable from this node
  const dhcpRouters = ctx.nodes.filter(
    (n) => (n.data.deviceType === 'router' || n.data.deviceType === 'gateway') && n.data.dhcpEnabled,
  )

  for (const router of dhcpRouters) {
    const path = findPath(src.id, router.id, ctx.nodes, ctx.edges)
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

    // Build 4-way DHCP handshake animation: DISCOVER → OFFER → REQUEST → ACK
    const legMs = (path.length - 1) * scaledHop(HOP_MS)
    const dhcpPackets: PacketAnim[] = [
      ...leg(path, ctx.edges, 'UDP', 'DISCOVER', 0),               // client → router
      ...leg(path, ctx.edges, 'UDP', 'OFFER',    legMs, true),     // router → client
      ...leg(path, ctx.edges, 'UDP', 'REQUEST',  2 * legMs),       // client → router
      ...leg(path, ctx.edges, 'UDP', 'ACK',      3 * legMs, true), // router → client
    ]
    ctx.dispatchPackets?.(dhcpPackets)

    // Update the node's IP address
    ctx.updateNodeData?.(src.id, {
      ip: assignedIp,
      gateway: `${prefix}.1`,
      subnet: '255.255.255.0',
    })

    return [
      info('DHCP DISCOVER sent (broadcast)…'),
      info(`DHCP OFFER received from ${router.data.ip}: ${assignedIp}`),
      info('DHCP REQUEST sent…'),
      info(`DHCP ACK — lease granted.`),
      out(''),
      out(`inet ${assignedIp}/24 brd ${prefix}.255 scope global dynamic eth0`),
      out(`   valid_lft 86400sec preferred_lft 86400sec`),
    ]
  }

  return [err('dhclient: No DHCP server found. Is a router with DHCP enabled connected to this network?')]
}

function cmdHelp(): Lines {
  return [
    out('Available commands:'),
    out('  ping <ip|host>     – Test connectivity'),
    out('  ipconfig           – Show IP configuration (Windows style)'),
    out('  ifconfig           – Show IP configuration (Linux style)'),
    out('  traceroute <ip|host>– Trace network path (hostname ok)'),
    out('  nslookup <domain>  – Query DNS for a domain name'),
    out('  arp -a             – Show ARP table (neighbours)'),
    out('  arp -d [ip|*]      – Delete one or all ARP entries'),
    out('  netstat            – Show active connections'),
    out('  route              – Show routing table'),
    out('  curl <url>         – Make HTTP request'),
    out('  ssh <ip>           – Connect to remote host or router (exit to quit)'),
    out('  dhclient           – Request IP from DHCP server'),
    out('  ipconfig /renew    – Same as dhclient (Windows style)'),
    out('  clear              – Clear terminal'),
    out('  help               – Show this help'),
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
    case 'route': return cmdRoute(args, ctx)
    case 'curl':
    case 'wget': return cmdCurl(args, ctx)
    case 'ssh': return cmdSsh(args, ctx)
    case 'dhclient': return cmdDhclient(args, ctx)
    case 'clear': return [{ type: 'output', text: '\x1bCLEAR' }]
    case 'help': return cmdHelp()
    case '': return []
    default: return [err(`command not found: ${cmd}`)]
  }
}
