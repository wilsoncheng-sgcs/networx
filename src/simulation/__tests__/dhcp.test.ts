import { describe, it, expect } from 'vitest'
import type { NetNode } from '../../types'
import { run, careConnect } from './helpers'
import { dhcpOffer } from '../terminal'
import { networkRange } from '../network'

type Net = ReturnType<typeof careConnect>
const set = (net: Net, id: string, patch: Partial<NetNode['data']>) => {
  const n = net.nodes.find((x) => x.id === id)!
  n.data = { ...n.data, ...patch }
  return net
}
const node = (net: Net, id: string) => net.nodes.find((n) => n.id === id)!

/** The clinic gateway as a DHCP server on 10.0.0.254/16 (not .1, not /24). */
const clinicDhcp = () => set(careConnect(), 'clinicgw', { ip: '10.0.0.254', subnet: '255.255.0.0', dhcpEnabled: true })

describe('DHCP hands out the server’s own gateway address and subnet mask', () => {
  it('a gateway on 10.0.0.254/16: the client gets gateway 10.0.0.254 and mask 255.255.0.0', () => {
    const { text, patches, captures } = run('reception', 'dhclient', clinicDhcp())
    const lease = patches.find((p) => p.id === 'reception' && p.patch.ip)!.patch
    expect(lease).toMatchObject({ ip: '10.0.0.100', gateway: '10.0.0.254', subnet: '255.255.0.0', ipMode: 'dhcp' })
    expect(text).toContain('inet 10.0.0.100/16 brd 10.0.255.255 scope global dynamic eth0')
    expect(text).toContain('gateway 10.0.0.254')
    for (const kind of ['DHCP Offer', 'DHCP ACK']) {
      const c = captures.find((x) => x.info.startsWith(kind))!
      expect(c.payload).toContain('subnet mask: 255.255.0.0')
      expect(c.payload).toContain('router (default gateway): 10.0.0.254')
    }
  })

  it('after the lease the client reaches the internet through that gateway', () => {
    const net = clinicDhcp()
    run('reception', 'dhclient', net)
    expect(run('reception', 'ping 203.0.113.80', net).text).toContain('64 bytes from 203.0.113.80')
  })

  it('the pool only offers addresses on the server’s network (never its network or broadcast address)', () => {
    const net = set(careConnect(), 'clinicgw', { ip: '10.0.0.1', subnet: '255.255.255.128', dhcpPool: '120-200', dhcpEnabled: true })
    const gw = node(net, 'clinicgw')
    const offered: string[] = []
    for (let i = 0; i < 10; i++) {
      const client = { ...node(net, 'reception'), id: `c${i}`, data: { ...node(net, 'reception').data, ip: '' } }
      const o = dhcpOffer(gw, client, net.nodes)
      if (!o) break
      offered.push(o.ip)
      net.nodes.push({ ...client, data: { ...client.data, ip: o.ip } })
    }
    expect(offered).toEqual(['10.0.0.120', '10.0.0.121', '10.0.0.122', '10.0.0.123', '10.0.0.124', '10.0.0.125', '10.0.0.126'])
    expect(networkRange('10.0.0.1', '255.255.255.128').broadcast).toBe('10.0.0.127')
  })

  it('renewing keeps the address the client already holds', () => {
    const net = clinicDhcp()
    run('reception', 'dhclient', net)
    const { patches } = run('reception', 'ipconfig /renew', net)
    expect(patches.find((p) => p.patch.ip)!.patch.ip).toBe('10.0.0.100')
  })

  it('a DHCP server that is switched off does not answer', () => {
    const net = set(clinicDhcp(), 'clinicgw', { isOn: false })
    expect(run('reception', 'dhclient', net).text).toContain('No DHCP server found')
  })
})
