import { sameSubnet, subnetToCidr } from './network'

/** The private address ranges (RFC 1918): they only exist inside their own network. */
export const PRIVATE_RANGES: Array<[string, string]> = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
]

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some(([net, mask]) => sameSubnet(ip, net, mask))
}

/** The private range `ip` is in, as a prefix (e.g. 10.0.0.0/8), or ''. */
export function privateRange(ip: string): string {
  const r = PRIVATE_RANGES.find(([net, mask]) => sameSubnet(ip, net, mask))
  return r ? `${r[0]}/${subnetToCidr(r[1])}` : ''
}
