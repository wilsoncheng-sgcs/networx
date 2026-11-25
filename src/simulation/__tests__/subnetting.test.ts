import { describe, it, expect } from 'vitest'
import { run } from './helpers'
import { PRESETS } from '../presets'
import { normaliseNetwork } from '../defaults'
import { clearAllDnsCaches } from '../dnsCache'
import { networkRange } from '../network'

const subnetting = () => {
  clearAllDnsCaches()
  const p = PRESETS.find((x) => x.id === 'subnetting')!
  return { nodes: normaliseNetwork(structuredClone(p.nodes), p.edges), edges: structuredClone(p.edges) }
}

describe('Subnetting (/29) preset', () => {
  it('two /29 subnets: PC 1 and PC 2 on 192.168.1.8, PC 3 and PC 4 on 192.168.1.16', () => {
    const net = subnetting()
    const nets = Object.fromEntries(net.nodes.filter((n) => n.data.deviceType === 'pc')
      .map((n) => [n.data.label, `${networkRange(n.data.ip, n.data.subnet).network}/${n.data.subnet}`]))
    expect(nets).toEqual({
      'PC 1': '192.168.1.8/255.255.255.248', 'PC 2': '192.168.1.8/255.255.255.248',
      'PC 3': '192.168.1.16/255.255.255.248', 'PC 4': '192.168.1.16/255.255.255.248',
    })
    expect(net.nodes.every((n) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(n.data.mac))).toBe(true)
  })

  it('same subnet: ping works, TTL 64 (the switch does not route)', () => {
    expect(run('pc1', 'ping 192.168.1.11', subnetting()).text).toContain('64 bytes from 192.168.1.11: icmp_seq=0 ttl=64')
    expect(run('pc3', 'ping 192.168.1.19', subnetting()).text).toContain('64 bytes from 192.168.1.19: icmp_seq=0 ttl=64')
  })

  it('other subnet: the PC asks for its gateway with ARP, and nothing answers', () => {
    const { text } = run('pc1', 'ping 192.168.1.18', subnetting())
    expect(text).toContain('From 192.168.1.10 icmp_seq=0 Destination Host Unreachable')
    expect(text).toContain('sends it to its default gateway 192.168.1.9')
    expect(run('pc4', 'ping 192.168.1.10', subnetting()).text).toContain('sends it to its default gateway 192.168.1.17')
  })
})
