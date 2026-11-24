import { describe, it, expect } from 'vitest'
import type { NetNode } from '../../types'
import { run, careConnect } from './helpers'
import { PRESETS } from '../presets'
import { normaliseNode } from '../defaults'

type Net = ReturnType<typeof careConnect>
const set = (net: Net, id: string, patch: Partial<NetNode['data']>) => {
  const n = net.nodes.find((x) => x.id === id)!
  n.data = { ...n.data, ...patch }
  return net
}
const presetNet = (id: string): Net => {
  const p = PRESETS.find((x) => x.id === id)!
  return { nodes: structuredClone(p.nodes).map(normaliseNode), edges: structuredClone(p.edges) }
}
const NO_ANSWER = "ⓘ The DNS server 203.0.113.53 didn't answer, so the name couldn't be turned into an IP address. Connecting by IP address still works."

describe('A1 — an unreachable DNS server times out; it never becomes 8.8.8.8', () => {
  const offline = () => set(careConnect(), 'ccdns', { isOn: false })

  it('nslookup: three queries to 203.0.113.53:53, no response, "no servers could be reached"', () => {
    const { text, captures } = run('patient', 'nslookup www.careconnect.example', offline())
    expect(text).toContain(';; connection timed out; no servers could be reached')
    expect(text).not.toContain('8.8.8.8')
    expect(text).not.toContain('NXDOMAIN')
    const dns = captures.filter((c) => c.app === 'DNS')
    expect(dns).toHaveLength(3)
    expect(dns.every((c) => c.dstIp === '203.0.113.53' && c.dstPort === 53 && c.transport === 'UDP')).toBe(true)
    expect(dns.every((c) => c.info.startsWith('Standard query') && !c.info.includes('response'))).toBe(true)
  })

  it('curl by name: could not resolve, and why; by IP address it still works', () => {
    const { text } = run('patient', 'curl http://www.careconnect.example', offline())
    expect(text).toContain('curl: (6) Could not resolve host: www.careconnect.example')
    expect(text).toContain(NO_ANSWER)
    expect(run('patient', 'curl http://203.0.113.80', offline()).text).toContain('CareConnect Medical Centre')
  })

  it('ping and ftp by name print their could-not-resolve line plus the ⓘ', () => {
    const ping = run('patient', 'ping www.careconnect.example', offline()).text
    expect(ping).toContain('Temporary failure in name resolution')
    expect(ping).toContain(NO_ANSWER)
    const ftp = run('reception', 'ftp files.careconnect.example ls', offline()).text
    expect(ftp).toContain('ftp: files.careconnect.example: Name or service not known')
    expect(ftp).toContain(NO_ANSWER)
  })

  it("the DNS server's own gateway is wrong: the queries arrive, no answer comes back", () => {
    const net = set(careConnect(), 'ccdns', { gateway: '203.0.113.254' })
    const { text, captures } = run('patient', 'nslookup www.careconnect.example', net)
    expect(text).toContain(';; connection timed out; no servers could be reached')
    const dns = captures.filter((c) => c.app === 'DNS')
    expect(dns).toHaveLength(3)
    expect(dns[0]!.route?.slice(-1)[0]).toBe('ccdns')
  })

  it("the client's own gateway is wrong: keeps the explanation of the client's mistake", () => {
    const net = set(careConnect(), 'docpc', { gateway: '10.0.0.254' })
    const { text } = run('docpc', 'curl http://www.careconnect.example', net)
    expect(text).toContain('curl: (6) Could not resolve host')
    expect(text).toContain("Names can't be looked up: the DNS server (203.0.113.53) can't be reached")
    expect(text).toContain('default gateway 10.0.0.254')
  })

  it('a network with no DNS server node asks 8.8.8.8 as before', () => {
    const { text } = run('pc1', 'nslookup example.com', presetNet('home-network'))
    expect(text).toContain('Server:   8.8.8.8')
    expect(text).toContain('93.184.216.34')
  })
})

describe('A2 — traceroute shows only devices that route', () => {
  const hopLines = (text: string) => text.split('\n').filter((l) => /^ \d+ {2}/.test(l))

  it("Patient's Laptop → 203.0.113.80: Home Gateway, three backbone hops, CareConnect Router, CareConnect Web", () => {
    const hops = hopLines(run('patient', 'traceroute 203.0.113.80').text)
    expect(hops.map((l) => l.match(/\((.*?)\)/)![1])).toEqual([
      'Home Gateway', 'ISP Gateway', 'Backbone router', 'Exchange point', 'CareConnect Router', 'CareConnect Web',
    ])
    expect(hops[0]).toContain('192.168.1.1')
    expect(hops[4]).toContain('198.51.100.1')   // the interface the probe arrived on
    expect(hops.join('\n')).not.toContain('Server Switch')
    expect(hops.join('\n')).not.toContain('0.0.0.0')
  })

  it("same subnet (through the Clinic Gateway's built-in switch) is one line: the destination", () => {
    const hops = hopLines(run('docpc', 'traceroute 10.0.0.11').text)
    expect(hops).toHaveLength(1)
    expect(hops[0]).toContain('10.0.0.11 (Reception PC)')
  })

  it('a hostname on the internet: the local routers, the backbone, then the host', () => {
    const hops = hopLines(run('patient', 'traceroute example.com').text)
    expect(hops.map((l) => l.match(/\((.*?)\)/)![1])).toEqual(['Home Gateway', 'ISP Gateway', 'Backbone router', 'Exchange point', 'example.com'])
  })
})

