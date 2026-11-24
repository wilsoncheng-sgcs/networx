import { describe, it, expect } from 'vitest'
import type { NetNode, IspRoute } from '../../types'
import { run, careConnect } from './helpers'
import { PRESETS } from '../presets'
import { normaliseNetwork, makeDefaultData } from '../defaults'
import { clearAllDnsCaches } from '../dnsCache'
import { routeBetween, HOST_TYPES } from '../routing'
import { announcement, validateIspRoute, parsePrefix, ispRouteFor } from '../isp'

type Net = ReturnType<typeof careConnect>
const node = (net: Net, id: string) => net.nodes.find((n) => n.id === id)!
const set = (net: Net, id: string, patch: Partial<NetNode['data']>) => {
  const n = node(net, id)
  n.data = { ...n.data, ...patch }
  return net
}
const withdrawn = () => set(careConnect(), 'net', { ispRoutes: [] })
const dev = (id: string, type: NetNode['data']['deviceType'], patch: Partial<NetNode['data']>): NetNode =>
  ({ id, type: 'device', position: { x: 0, y: 0 }, data: { ...makeDefaultData(type, id), ...patch } })

/** CareConnect plus a branch office on a public network (192.0.2.0/24) that the ISP doesn't route yet. */
function withBranch(): Net {
  const net = careConnect()
  net.nodes.push(
    dev('br', 'router', { label: 'Branch Router', ip: '192.0.2.1', wanIp: '198.51.100.200' }),
    dev('brsrv', 'server', { label: 'Branch Server', ip: '192.0.2.10', gateway: '192.0.2.1', dnsServer: '203.0.113.53' }),
  )
  net.edges.push({ id: 'br-e1', source: 'net', target: 'br' }, { id: 'br-e2', source: 'br', target: 'brsrv' })
  return net
}

describe('ISP routes: loading a network keeps it working as before', () => {
  it('CareConnect gets one route: 203.0.113.0/24 → the CareConnect Router (198.51.100.1)', () => {
    const routes = node(careConnect(), 'net').data.ispRoutes!
    expect(routes.map((r) => `${r.destination}/${r.subnet} → ${r.nextHop}`)).toEqual(['203.0.113.0/255.255.255.0 → 198.51.100.1'])
  })

  it('every preset: the same results between every pair of devices as with every public network reachable', () => {
    for (const p of PRESETS) {
      clearAllDnsCaches()
      const nodes = normaliseNetwork(structuredClone(p.nodes), p.edges)
      const legacy = nodes.map((n) => n.data.deviceType === 'cloud' ? { ...n, data: { ...n.data, ispRoutes: undefined } } : n)
      const targets = nodes.flatMap((n) => [n.data.ip, n.data.wanIp as string].filter((ip) => ip && ip !== '0.0.0.0').map((ip) => ({ n, ip })))
      for (const src of nodes.filter((n) => HOST_TYPES.includes(n.data.deviceType))) {
        for (const { n: dst, ip } of targets) {
          if (dst.id === src.id) continue
          const a = routeBetween(src, dst, ip, nodes, p.edges)
          const b = routeBetween(src, dst, ip, legacy, p.edges)
          expect(`${p.id} ${src.id}→${ip}: ${a.ok ? 'ok' : a.failure}`).toBe(`${p.id} ${src.id}→${ip}: ${b.ok ? 'ok' : b.failure}`)
        }
      }
    }
  })

  it('a new Internet node starts with no routes, and loading the network leaves it empty', () => {
    const nodes = normaliseNetwork([
      dev('c', 'cloud', {}), dev('r', 'router', { ip: '203.0.113.1', wanIp: '198.51.100.9' }),
    ], [{ id: 'e', source: 'c', target: 'r' }])
    expect(nodes.find((n) => n.id === 'c')!.data.ispRoutes).toEqual([])
  })
})

describe('no ISP route: a public network is unreachable from the internet', () => {
  it('curl by address times out at the ISP, and the ⓘ names the missing route', () => {
    const { text, captures } = run('patient', 'curl http://203.0.113.80', withdrawn())
    expect(text).toContain('curl: (28) Failed to connect to 203.0.113.80 port 80 after 75000 ms: Timeout was reached')
    expect(text).toContain('ⓘ The internet has no route to 203.0.113.80: no ISP has a route for 203.0.113.0/24, the network behind CareConnect Router.')
    expect(text).toContain('add 203.0.113.0/24 → 198.51.100.1')
    const syns = captures.filter((c) => c.tcpFlags === 'SYN')
    expect(syns.length).toBeGreaterThan(0)
    expect(syns.every((c) => c.route?.slice(-1)[0] === 'net')).toBe(true)
  })

  it('names stop resolving too: the DNS server is on that network', () => {
    const { text } = run('patient', 'nslookup www.careconnect.example', withdrawn())
    expect(text).toContain(';; connection timed out; no servers could be reached')
    expect(text).toContain('no ISP has a route for 203.0.113.0/24')
  })

  it('ping times out; traceroute shows the ISP and then silence', () => {
    expect(run('patient', 'ping 203.0.113.80', withdrawn()).text).toContain('Request timeout for icmp_seq 0')
    const trace = run('patient', 'traceroute 203.0.113.80', withdrawn()).text
    expect(trace).toContain('195.68.128.1 (ISP Gateway)')
    expect(trace).toMatch(/ \d+ {2}\* \* \*/)
    const hops = trace.split('\n').filter((l) => /^ \d+ {2}/.test(l))
    expect(hops.some((l) => l.includes('CareConnect Router'))).toBe(false)
  })

  it("the router's WAN address is still reachable: it is on the ISP's own network", () => {
    expect(run('patient', 'ping 198.51.100.1', withdrawn()).text).toContain('64 bytes from 198.51.100.1')
  })

  it('inside the network nothing changes', () => {
    expect(run('ccweb', 'ping 203.0.113.53', withdrawn()).text).toContain('64 bytes from 203.0.113.53')
  })

  it('a route with the wrong next hop: the ⓘ says where it goes instead', () => {
    const net = set(careConnect(), 'net', { ispRoutes: [{ id: 'x', destination: '203.0.113.0', subnet: '255.255.255.0', nextHop: '198.51.100.77' }] })
    const { text } = run('patient', 'curl http://203.0.113.80', net)
    expect(text).toContain("the ISP's route for 203.0.113.0/24 sends it to 198.51.100.77 (Clinic Gateway), but 203.0.113.80 is behind CareConnect Router (198.51.100.1)")
  })
})

describe('the reply needs a route back', () => {
  it('a public sender whose network is not announced: the request arrives, the reply has no way back', () => {
    const { text, captures } = run('brsrv', 'curl http://203.0.113.80', withBranch())
    expect(text).toContain('curl: (28)')
    expect(text).toContain("CareConnect Web received the request but can't send the reply: the internet has no route back to 192.0.2.10 — no ISP has a route for 192.0.2.0/24, the network behind Branch Router.")
    expect(captures.filter((c) => c.tcpFlags === 'SYN').every((c) => c.route?.slice(-1)[0] === 'ccweb')).toBe(true)
    expect(captures.some((c) => c.tcpFlags === 'SYN, ACK')).toBe(false)
  })

  it('announcing the branch network fixes it, both ways', () => {
    const net = withBranch()
    const routes = node(net, 'net').data.ispRoutes!
    set(net, 'net', { ispRoutes: [...routes, { id: 'b', destination: '192.0.2.0', subnet: '255.255.255.0', nextHop: '198.51.100.200' }] })
    expect(run('brsrv', 'curl http://203.0.113.80', net).text).toContain('CareConnect Medical Centre')
    expect(run('patient', 'ping 192.0.2.10', net).text).toContain('64 bytes from 192.0.2.10')
  })

  it('a private sender behind NAT is answered at its gateway: no route needed', () => {
    expect(run('reception', 'curl http://203.0.113.80', careConnect()).text).toContain('CareConnect Medical Centre')
  })
})

describe('a firewall in front of the router', () => {
  it("the route to the router's WAN address still works through it", () => {
    const net = careConnect()
    net.nodes.push(dev('ccfw', 'firewall', { label: 'CareConnect Firewall', ip: '198.51.100.2' }))
    net.edges = net.edges.filter((e) => e.id !== 'cc-e3')
    net.edges.push({ id: 'fw-e1', source: 'net', target: 'ccfw' }, { id: 'fw-e2', source: 'ccfw', target: 'ccrouter' })
    expect(run('patient', 'curl http://203.0.113.80', net).text).toContain('CareConnect Medical Centre')
    const a = announcement(node(net, 'ccrouter'), net.nodes, net.edges)
    expect(a.state).toBe('announced')
  })
})

describe("a router's announcement status", () => {
  it('announced, not announced, wrong next hop, private', () => {
    expect(announcement(node(careConnect(), 'ccrouter'), careConnect().nodes, careConnect().edges)).toMatchObject({ state: 'announced', prefix: '203.0.113.0/24', nextHop: '198.51.100.1' })
    const w = withdrawn()
    expect(announcement(node(w, 'ccrouter'), w.nodes, w.edges)).toMatchObject({ state: 'not-announced', nextHop: '198.51.100.1' })
    const wrong = set(careConnect(), 'net', { ispRoutes: [{ id: 'x', destination: '203.0.113.0', subnet: '255.255.255.0', nextHop: '198.51.100.77' }] })
    expect(announcement(node(wrong, 'ccrouter'), wrong.nodes, wrong.edges).state).toBe('wrong-hop')
    const c = careConnect()
    expect(announcement(node(c, 'clinicgw'), c.nodes, c.edges)).toMatchObject({ state: 'private', prefix: '10.0.0.0/24', range: '10.0.0.0/8' })
  })
})

describe('adding a route', () => {
  const nodes = careConnect().nodes
  const route = (s: string, nextHop: string) => ({ ...parsePrefix(s)!, nextHop })

  it('accepts a public network and a WAN address', () => {
    expect(validateIspRoute(route('203.0.113.0/24', '198.51.100.1'), nodes)).toBeNull()
  })
  it('refuses private networks: ISPs never carry them', () => {
    expect(validateIspRoute(route('10.0.0.0/24', '198.51.100.77'), nodes)).toContain('is private (10.0.0.0/8)')
  })
  it('needs the start of a network, and a next hop that is a WAN address', () => {
    expect(validateIspRoute(route('203.0.113.80/24', '198.51.100.1'), nodes)).toContain('use 203.0.113.0/24')
    expect(validateIspRoute(route('203.0.113.0/24', '198.51.100.99'), nodes)).toContain('No router, gateway or firewall has the WAN address 198.51.100.99')
    expect(parsePrefix('203.0.113.0/33')).toBeNull()
    expect(parsePrefix('203.0.113.7')).toEqual({ destination: '203.0.113.7', subnet: '255.255.255.255' })
  })
  it('the most specific route wins', () => {
    const routes: IspRoute[] = [
      { id: 'a', destination: '203.0.0.0', subnet: '255.255.0.0', nextHop: '198.51.100.77' },
      { id: 'b', destination: '203.0.113.0', subnet: '255.255.255.0', nextHop: '198.51.100.1' },
    ]
    expect(ispRouteFor(routes, '203.0.113.80')!.id).toBe('b')
    expect(ispRouteFor(routes, '203.0.5.1')!.id).toBe('a')
  })
})
