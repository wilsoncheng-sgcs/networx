import type { NetNode } from '../types'
import type { TermContext } from './context'
import { findPath, nodeByIp } from './network'

/** Well-known internet names, answered (non-authoritatively) when the local DNS server has no record. */
export const PUBLIC_IPS: Record<string, string> = {
  'google.com':      '142.250.185.46',
  'www.google.com':  '142.250.185.46',
  'youtube.com':     '142.250.68.110',
  'bbc.co.uk':       '151.101.0.81',
  'bbc.com':         '151.101.0.81',
  'example.com':     '93.184.216.34',
  'cloudflare.com':  '104.16.133.229',
  'github.com':      '140.82.121.4',
  'amazon.co.uk':    '54.239.28.85',
  'microsoft.com':   '20.112.52.29',
  'apple.com':       '17.253.144.10',
  'twitter.com':     '104.244.42.193',
  'x.com':           '104.244.42.193',
  'facebook.com':    '157.240.241.35',
  'wikipedia.org':   '208.80.154.224',
  'ocr.org.uk':      '213.219.152.175',
  'aqa.org.uk':      '23.55.180.103',
  'eduqas.co.uk':    '185.43.135.28',
}

/** The public resolver used when no DNS server node is reachable but the internet is. */
export const PUBLIC_RESOLVER_IP = '8.8.8.8'

export function isIp(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)
}

export interface Resolved {
  name: string                 // what the user typed
  ip: string
  node: NetNode | null         // the node that answers for this IP (the cloud node for internet hosts)
  dnsServerNode: NetNode | null
  dnsServerIp: string | null
  authoritative: boolean
}

export interface ResolveError {
  name: string
  error: 'nxdomain' | 'no-dns' | 'no-route'
  dnsServerNode: NetNode | null
  dnsServerIp: string | null
}

export type Resolution = Resolved | ResolveError

export function isResolveError(r: Resolution): r is ResolveError {
  return 'error' in r
}

function reachable(node: NetNode | undefined, ctx: TermContext): node is NetNode {
  return !!node && node.data.isOn !== false && !!findPath(ctx.selfId, node.id, ctx.nodes, ctx.edges)
}

function reachableCloud(ctx: TermContext): NetNode | undefined {
  return ctx.nodes.find((n) => n.data.deviceType === 'cloud' && reachable(n, ctx))
}

const publicIpSet = () => new Set(Object.values(PUBLIC_IPS))

/** Which node answers for `ip`, as seen from this device: a reachable node with that IP, else the internet. */
function nodeForIp(ip: string, ctx: TermContext): NetNode | null {
  const node = nodeByIp(ip, ctx.nodes)
  if (node && node.data.deviceType !== 'cloud') {
    return findPath(ctx.selfId, node.id, ctx.nodes, ctx.edges) ? node : null
  }
  const cloud = reachableCloud(ctx)
  return cloud && publicIpSet().has(ip) ? cloud : null
}

/**
 * Resolve a name or IP the way every command does (spec §2.5).
 * Never invents an address: an unknown name is NXDOMAIN.
 */
export function resolveTarget(nameOrIp: string, ctx: TermContext): Resolution {
  const name = nameOrIp
  if (isIp(nameOrIp)) {
    const node = nodeForIp(nameOrIp, ctx)
    if (!node) return { name, error: 'no-route', dnsServerNode: null, dnsServerIp: null }
    return { name, ip: nameOrIp, node, dnsServerNode: null, dnsServerIp: null, authoritative: true }
  }

  const lower = nameOrIp.toLowerCase()
  const dns = ctx.nodes.find((n) => n.data.deviceType === 'dns')
  if (reachable(dns, ctx)) {
    const dnsIp = dns.data.ip || PUBLIC_RESOLVER_IP
    const record = (dns.data.dnsRecords ?? []).find((r) => r.hostname.toLowerCase() === lower)
    const ip = record?.ip ?? PUBLIC_IPS[lower]
    if (!ip) return { name, error: 'nxdomain', dnsServerNode: dns, dnsServerIp: dnsIp }
    return { name, ip, node: nodeForIp(ip, ctx), dnsServerNode: dns, dnsServerIp: dnsIp, authoritative: !!record }
  }

  const cloud = reachableCloud(ctx)
  if (cloud) {
    const ip = PUBLIC_IPS[lower]
    if (!ip) return { name, error: 'nxdomain', dnsServerNode: cloud, dnsServerIp: PUBLIC_RESOLVER_IP }
    return { name, ip, node: cloud, dnsServerNode: cloud, dnsServerIp: PUBLIC_RESOLVER_IP, authoritative: false }
  }

  return { name, error: 'no-dns', dnsServerNode: null, dnsServerIp: null }
}

/** The DNS server this device would ask: the DNS node if reachable, else the public resolver via the internet. */
export function dnsServerFor(ctx: TermContext): { node: NetNode; ip: string } | null {
  const dns = ctx.nodes.find((n) => n.data.deviceType === 'dns')
  if (reachable(dns, ctx)) return { node: dns, ip: dns.data.ip || PUBLIC_RESOLVER_IP }
  const cloud = reachableCloud(ctx)
  return cloud ? { node: cloud, ip: PUBLIC_RESOLVER_IP } : null
}
