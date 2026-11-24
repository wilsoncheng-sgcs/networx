import { describe, it, expect } from 'vitest'
import type { NetNode } from '../../types'
import { isPrivateIp, findSegmentPath } from '../routing'
import { run, careConnect } from './helpers'

const set = (net: ReturnType<typeof careConnect>, id: string, patch: Partial<NetNode['data']>) => {
  const n = net.nodes.find((x) => x.id === id)!
  n.data = { ...n.data, ...patch }
  return net
}

describe('private addresses', () => {
  it('knows the three private ranges', () => {
    for (const ip of ['10.0.0.11', '172.16.5.1', '172.31.255.254', '192.168.1.1']) expect(isPrivateIp(ip)).toBe(true)
    for (const ip of ['203.0.113.80', '172.32.0.1', '8.8.8.8', '198.51.100.77']) expect(isPrivateIp(ip)).toBe(false)
  })

  it("the patient can't reach the clinic's private addresses across the internet", () => {
    const { text, captures } = run('patient', 'ping 10.0.0.11')
    expect(text).toContain('Request timeout for icmp_seq 0')
    expect(text).toContain('4 packets transmitted, 0 packets received, 100.0% packet loss')
    expect(text).toContain('ⓘ 10.0.0.11 is a private address (10.0.0.0/8)')
    expect(text).not.toContain('bytes from')
    // The echo requests get as far as the internet and are dropped there; no replies
    const icmp = captures.filter((c) => c.app === 'ICMP')
    expect(icmp).toHaveLength(4)
    expect(icmp.every((c) => c.info.startsWith('Echo (ping) request'))).toBe(true)
    expect(icmp[0]!.route?.slice(-1)[0]).toBe('net')
  })

  it('curl, ssh and ftp to a private address from outside time out', () => {
    expect(run('patient', 'curl http://10.0.0.11').text).toContain('curl: (28) Failed to connect to 10.0.0.11 port 80 after 75000 ms: Timeout was reached')
    expect(run('patient', 'ssh 10.0.0.11').text).toContain('ssh: connect to host 10.0.0.11 port 22: Connection timed out')
    const syns = run('patient', 'curl http://10.0.0.11').captures.filter((c) => c.tcpFlags === 'SYN')
    expect(syns.map((c) => c.info)).toEqual(['[SYN] Seq=0', '[TCP Retransmission] [SYN] Seq=0', '[TCP Retransmission] [SYN] Seq=0'])
  })

  it("the clinic gateway's public address is reachable from outside", () => {
    expect(run('patient', 'ping 198.51.100.77').text).toContain('64 bytes from 198.51.100.77')
  })

  it('devices on the same private network still reach each other through their gateway', () => {
    expect(run('reception', 'ping 10.0.0.13').text).toContain('64 bytes from 10.0.0.13')
    expect(run('reception', 'ping 10.0.0.1').text).toContain('64 bytes from 10.0.0.1')
  })

  it('inside to outside still works (replies come back through NAT)', () => {
    expect(run('reception', 'curl http://www.careconnect.example').text).toContain('CareConnect Medical Centre')
    expect(run('patient', 'ping example.com').text).toContain('bytes from')
  })

  it('the same private address in two networks: you reach the one on your side', () => {
    const net = careConnect()
    const homegw = net.nodes.find((n) => n.id === 'homegw')!
    const patient = net.nodes.find((n) => n.id === 'patient')!
    net.nodes.push(
      { ...structuredClone(homegw), id: 'homegw2', data: { ...structuredClone(homegw.data), label: 'Second Home Gateway', wanIp: '198.51.100.50', mac: 'aa:bb:cc:05:00:01' } },
      { ...structuredClone(patient), id: 'laptop2', data: { ...structuredClone(patient.data), label: 'Second Laptop', ip: '192.168.1.50', mac: 'aa:bb:cc:05:00:50' } },
    )
    net.edges.push(
      { id: 'h2-e1', source: 'homegw2', target: 'net' },
      { id: 'h2-e2', source: 'laptop2', target: 'homegw2' },
    )
    const { text, captures } = run('laptop2', 'ping 192.168.1.1', net)
    expect(text).toContain('64 bytes from 192.168.1.1')
    expect(captures.find((c) => c.app === 'ICMP')!.route).toEqual(['laptop2', 'homegw2'])
  })
})

describe('subnets and default gateways', () => {
  it('no default gateway: anything off the subnet is unreachable, and nothing is sent', () => {
    const net = set(careConnect(), 'reception', { gateway: '' })
    const { text, captures } = run('reception', 'ping 203.0.113.80', net)
    expect(text).toContain('ping: sendto: Network is unreachable')
    expect(text).toContain('it has no default gateway')
    expect(captures).toHaveLength(0)
    // The local network still works
    expect(run('reception', 'ping 10.0.0.13', set(careConnect(), 'reception', { gateway: '' })).text).toContain('64 bytes from 10.0.0.13')
  })

  it('no default gateway: names fail first, because the DNS server is off the subnet', () => {
    const net = set(careConnect(), 'reception', { gateway: '' })
    expect(run('reception', 'curl http://www.careconnect.example', net).text).toContain('curl: (6) Could not resolve host: www.careconnect.example')
  })

  it('a gateway address nobody has: ARP for it gets no answer', () => {
    const net = set(careConnect(), 'reception', { gateway: '10.0.0.254' })
    const { text, captures } = run('reception', 'ping 203.0.113.80', net)
    expect(text).toContain('From 10.0.0.11 icmp_seq=0 Destination Host Unreachable')
    expect(text).toContain('default gateway 10.0.0.254')
    const arp = captures.filter((c) => c.app === 'ARP')
    expect(arp).toHaveLength(3)
    expect(arp.every((c) => c.info === 'Who has 10.0.0.254? Tell 10.0.0.11' && c.dstMac === 'ff:ff:ff:ff:ff:ff')).toBe(true)
  })

  it('a device moved to another subnet loses its gateway and its neighbours', () => {
    const net = set(careConnect(), 'reception', { ip: '10.0.1.11' })
    const { text } = run('reception', 'ping 10.0.0.13', net)
    expect(text).toContain('ping: sendto: Network is unreachable')
    expect(text).toContain("default gateway 10.0.0.1 isn't on that subnet")
  })

  it('a same-subnet address with no device behind it: Destination Host Unreachable', () => {
    const { text } = run('reception', 'ping 10.0.0.99')
    expect(text).toContain('From 10.0.0.11 icmp_seq=0 Destination Host Unreachable')
    expect(text).toContain('nothing answered')
  })

  it("a server with the wrong gateway gets the request but can't reply", () => {
    const net = set(careConnect(), 'ccweb', { gateway: '203.0.113.254' })
    const { text, captures } = run('patient', 'curl http://www.careconnect.example', net)
    expect(text).toContain('curl: (28) Failed to connect to www.careconnect.example port 80 after 75000 ms: Timeout was reached')
    expect(text).toContain("CareConnect Web received the request but can't send the reply")
    // The SYNs reach the web server; no SYN-ACK
    const syn = captures.find((c) => c.tcpFlags === 'SYN')!
    expect(syn.route?.slice(-1)[0]).toBe('ccweb')
    expect(captures.some((c) => c.tcpFlags === 'SYN, ACK')).toBe(false)
  })

  it('DHCP only reaches a server on the same network segment', () => {
    const net = careConnect()
    const { text, patches } = run('reception', 'dhclient', net)
    expect(text).toContain('No DHCP server found')
    expect(patches.some((p) => p.patch.ip?.startsWith('192.168.1.'))).toBe(false)
  })

  it('a home gateway switches between its LAN devices, but not from its WAN side', () => {
    const net = careConnect()
    expect(findSegmentPath('reception', 'docpc', net.nodes, net.edges)).toEqual(['reception', 'clinicgw', 'docpc'])
    expect(findSegmentPath('net', 'reception', net.nodes, net.edges)).toBeNull()
  })
})

describe('the last router must be on the destination\'s subnet', () => {
  /** A laptop with a clinic-style address plugged into the patient's home gateway. */
  function misplacedLaptop(ip = '10.0.0.5') {
    const net = careConnect()
    const patient = net.nodes.find((n) => n.id === 'patient')!
    net.nodes.push({ ...structuredClone(patient), id: 'laptop101', data: { ...structuredClone(patient.data), label: 'Laptop 101', ip, gateway: ip.replace(/\.\d+$/, '.1'), mac: 'aa:bb:cc:06:01:01' } })
    net.edges.push({ id: 'l101-e1', source: 'laptop101', target: 'homegw' })
    return net
  }

  it("a device on the wrong subnet behind a gateway isn't reached: the packets never go to it", () => {
    const { text, captures } = run('patient', 'ping 10.0.0.5', misplacedLaptop())
    expect(text).toContain('Request timeout for icmp_seq 0')
    expect(text).toContain("isn't on Home Gateway's network")
    const icmp = captures.filter((c) => c.app === 'ICMP')
    expect(icmp.length).toBeGreaterThan(0)
    expect(icmp.every((c) => !c.route?.includes('laptop101'))).toBe(true)
    // Home Gateway sends it out to the internet, where a private address is dropped
    expect(icmp[0]!.route).toEqual(['patient', 'homegw', 'net'])
  })

  it('the same laptop with an address on the home LAN is reached', () => {
    expect(run('patient', 'ping 192.168.1.50', misplacedLaptop('192.168.1.50')).text).toContain('64 bytes from 192.168.1.50')
  })
})
