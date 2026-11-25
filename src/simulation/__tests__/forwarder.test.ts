import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FirewallRule, NetNode, PendingCapture } from '../../types'
import { run, careConnect } from './helpers'
import { setDnsCacheClock } from '../dnsCache'
import { makeDefaultData, normaliseNetwork } from '../defaults'
import * as clock from '../clock'

/**
 * A local DNS server forwards names it doesn't hold to its forwarder (8.8.8.8 by default), and
 * caches the answers for their TTL. CareConnect's DNS server (203.0.113.53) holds careconnect.example.
 */

let t = 0
beforeEach(() => { t = 0; setDnsCacheClock(() => t) })
afterEach(() => setDnsCacheClock(() => clock.now()))

type Net = ReturnType<typeof careConnect>
const dnsRows = (c: PendingCapture[]) => c.filter((x) => x.app === 'DNS').sort((a, b) => a.delayMs - b.delayMs)
const setData = (net: Net, id: string, patch: Partial<NetNode['data']>) => {
  const n = net.nodes.find((x) => x.id === id)!
  n.data = { ...n.data, ...patch }
  return net
}
/** CareConnect with its router unplugged from the internet: the DNS server is cut off. */
const isolated = () => {
  const net = careConnect()
  net.edges = net.edges.filter((e) => e.id !== 'cc-e3')
  return net
}

describe('the forwarder setting', () => {
  it('a new DNS server forwards to 8.8.8.8, and an older save without the setting gets it too', () => {
    expect(makeDefaultData('dns', 'd1').dnsForwarder).toBe('8.8.8.8')
    const old = { id: 'd1', type: 'device', position: { x: 0, y: 0 }, data: { ...makeDefaultData('dns', 'd1') } } as NetNode
    delete old.data.dnsForwarder
    expect(normaliseNetwork([old], [])[0]!.data.dnsForwarder).toBe('8.8.8.8')
  })
})

describe('a name the DNS server does not hold is forwarded', () => {
  it('dig example.com: client → DNS server → 8.8.8.8 → DNS server → client, not authoritative', () => {
    const { text, captures } = run('ccweb', 'dig example.com')
    expect(text).toContain('93.184.216.34')
    expect(text).toContain(';; flags: qr rd ra;')
    expect(text).toContain('ⓘ No aa flag: DNS Server doesn\'t hold this name, so it asked its forwarder (8.8.8.8) and passed the answer on.')
    const rows = dnsRows(captures)
    expect(rows.map((r) => `${r.srcIp}:${r.srcPort === 53 ? 53 : 'eph'} → ${r.dstIp}:${r.dstPort === 53 ? 53 : 'eph'}`)).toEqual([
      '203.0.113.80:eph → 203.0.113.53:53',
      '203.0.113.53:eph → 8.8.8.8:53',
      '8.8.8.8:53 → 203.0.113.53:eph',
      '203.0.113.53:53 → 203.0.113.80:eph',
    ])
    // The server's own query uses its own ephemeral port; every packet is a Step (step mode pauses on each)
    expect(rows[1]!.srcPort).toBeGreaterThanOrEqual(49152)
    expect(rows[1]!.srcPort).toBe(rows[2]!.dstPort)
    expect(rows.every((r) => r.conversationId.startsWith('conv-'))).toBe(true)
    // The client's query and answer are one conversation; the upstream exchange is another
    expect(rows[0]!.conversationId).toBe(rows[3]!.conversationId)
    expect([rows[0]!.stepIndex, rows[3]!.stepIndex]).toEqual([0, 1])
    expect(rows[1]!.conversationId).not.toBe(rows[0]!.conversationId)
    expect(rows[2]!.info).toMatch(/^Standard query response 0x[0-9a-f]{4} A example\.com A 93\.184\.216\.34$/)
  })

  it('the answer arrives after the upstream exchange, and the query time includes it', () => {
    const own = run('ccweb', 'dig careconnect.example')
    const fwd = run('ccweb', 'dig example.com')
    const ms = (s: string) => Number(s.match(/;; Query time: (\d+) msec/)![1])
    expect(ms(fwd.text)).toBeGreaterThan(ms(own.text))
    const rows = dnsRows(fwd.captures)
    const answerLine = fwd.lines.find((l) => l.text.startsWith(';; ANSWER SECTION'))!
    expect(answerLine.delayMs!).toBeGreaterThan(rows[3]!.delayMs)
  })

  it("finds a name held by another organisation's public DNS server, through 8.8.8.8", () => {
    const net = careConnect()
    const other: NetNode = { id: 'otherdns', type: 'device', position: { x: 0, y: 0 }, data: {
      ...makeDefaultData('dns', 'otherdns'), label: 'Other DNS', ip: '203.0.113.99', gateway: '203.0.113.1',
      dnsRecords: [{ id: 'o1', name: 'www.other.example', type: 'A', value: '203.0.113.98', ttl: 600 }] } }
    net.nodes.push(other)
    net.edges.push({ id: 'o-e1', source: 'ccsw', target: 'otherdns' })
    const { text } = run('ccweb', 'nslookup www.other.example', net)
    expect(text).toContain('Non-authoritative answer:')
    expect(text).toContain('Address:  203.0.113.98')
  })

  it('a name inside its own domain that it does not hold is NXDOMAIN, answered locally with aa', () => {
    const { text, captures } = run('ccweb', 'dig nope.careconnect.example')
    expect(text).toContain('status: NXDOMAIN')
    expect(text).toContain(';; flags: qr aa rd ra;')
    expect(dnsRows(captures)).toHaveLength(2)
  })

  it('a name nobody holds: NXDOMAIN from the forwarder, passed on', () => {
    const { text, captures } = run('ccweb', 'dig nosuch.example.org')
    expect(text).toContain('status: NXDOMAIN')
    expect(text).toContain("DNS Server doesn't hold nosuch.example.org, and its forwarder found no records for it either")
    expect(dnsRows(captures)).toHaveLength(4)
  })
})

describe('the DNS server caches what its forwarder answers', () => {
  it('a second lookup (from any device) has no upstream leg until the TTL runs out', () => {
    const net = careConnect()
    expect(dnsRows(run('ccweb', 'nslookup example.com', net).captures)).toHaveLength(4)
    t = 100_000
    const second = run('reception', 'dig example.com', net)
    expect(dnsRows(second.captures)).toHaveLength(2)
    // PUBLIC_TTL is 300 s: 100 s later, 200 s are left
    expect(second.text).toMatch(/example\.com\. +200\tIN\tA\t93\.184\.216\.34/)
    expect(second.text).toContain("It answered from its own cache of what its forwarder (8.8.8.8) told it earlier, so nothing more was sent upstream.")
    expect(run('ccdns', 'dnscache', net).text).toMatch(/example\.com +A +200 s +93\.184\.216\.34/)
    // Expired: the server asks again
    t = 301_000
    expect(dnsRows(run('ccweb', 'nslookup example.com', net).captures)).toHaveLength(4)
  })

  it('flushdns on the DNS server empties what it got from its forwarder', () => {
    const net = careConnect()
    run('ccweb', 'nslookup example.com', net)
    expect(run('ccdns', 'flushdns', net).text).toContain('the answers it got from its forwarder')
    expect(dnsRows(run('ccweb', 'nslookup example.com', net).captures)).toHaveLength(4)
  })
})

describe('the forwarder cannot be reached', () => {
  it('isolated: SERVFAIL after the server waits 3 s, with the reason; its own names still work', () => {
    const net = isolated()
    const { text, captures } = run('ccweb', 'dig example.com', net)
    expect(text).toContain('status: SERVFAIL')
    expect(text).toContain("ⓘ DNS Server doesn't hold example.com, so it asked its forwarder 8.8.8.8 — which didn't answer, so after 3 s DNS Server gave up and answered SERVFAIL.")
    expect(text).toMatch(/;; Query time: 30\d\d msec/)
    const rows = dnsRows(captures)
    // No connection at all: the server's query can't leave it. The client's query, then SERVFAIL 3 s later
    expect(rows).toHaveLength(2)
    expect(rows[1]!.info).toMatch(/Server failure A example\.com$/)
    expect(rows[1]!.delayMs - rows[0]!.delayMs).toBeGreaterThanOrEqual(3000)
    expect(run('ccweb', 'dig www.careconnect.example', net).text).toContain('203.0.113.80')
  })

  it('ping and curl explain why the name failed', () => {
    const ping = run('ccweb', 'ping example.com', isolated()).text
    expect(ping).toContain('ping: example.com: Temporary failure in name resolution')
    expect(ping).toContain('asked its forwarder 8.8.8.8 — which didn\'t answer')
    expect(run('ccweb', 'nslookup example.com', isolated()).text).toContain("** server can't find example.com: SERVFAIL")
  })

  it('SERVFAIL is not cached: once the link is back, the next lookup works', () => {
    const net = isolated()
    run('ccweb', 'nslookup example.com', net)
    net.edges.push({ id: 'cc-e3', source: 'net', target: 'ccrouter' })
    expect(run('ccweb', 'nslookup example.com', net).text).toContain('93.184.216.34')
  })

  it("a firewall rule that drops the server's DNS queries: SERVFAIL, and the firewall is named", () => {
    const rule = (direction: 'in' | 'out', protocol: FirewallRule['protocol'], port: string, action: 'allow' | 'deny'): FirewallRule =>
      ({ id: `${direction}${protocol}${port}${action}`, direction, protocol, port, action, srcIp: '*', dstIp: '*' })
    const net = careConnect()
    const fw: NetNode = { id: 'ccfw', type: 'device', position: { x: 0, y: 0 }, data: { ...makeDefaultData('firewall', 'ccfw'), label: 'CareConnect Firewall', ip: '198.51.100.2' } }
    fw.data.rules = [rule('out', 'UDP', '53', 'deny'), rule('in', 'ANY', '*', 'allow'), rule('out', 'ANY', '*', 'allow')]
    net.nodes.push(fw)
    net.edges = net.edges.filter((e) => e.id !== 'cc-e3')
    net.edges.push({ id: 'fw-e1', source: 'net', target: 'ccfw' }, { id: 'fw-e2', source: 'ccfw', target: 'ccrouter' })
    const { text, captures } = run('ccweb', 'dig example.com', net)
    expect(text).toContain('status: SERVFAIL')
    expect(text).toContain('CareConnect Firewall')
    // The server's query is sent once, gets as far as the firewall, and nothing comes back
    const rows = dnsRows(captures)
    expect(rows.map((r) => `${r.srcIp}→${r.dstIp}`)).toEqual(['203.0.113.80→203.0.113.53', '203.0.113.53→8.8.8.8', '203.0.113.53→203.0.113.80'])
    expect(rows[1]!.route?.[rows[1]!.route.length - 1]).toBe('ccfw')
    expect(rows[2]!.delayMs - rows[1]!.delayMs).toBeGreaterThanOrEqual(3000)
  })

  it('the forwarder is switched off: SERVFAIL', () => {
    const net = careConnect()
    const second: NetNode = { id: 'dns2', type: 'device', position: { x: 0, y: 0 }, data: {
      ...makeDefaultData('dns', 'dns2'), label: 'Upstream DNS', ip: '203.0.113.54', gateway: '203.0.113.1', isOn: false, dnsRecords: [] } }
    net.nodes.push(second)
    net.edges.push({ id: 'd2-e1', source: 'ccsw', target: 'dns2' })
    setData(net, 'ccdns', { dnsForwarder: '203.0.113.54' })
    const { text } = run('ccweb', 'dig example.com', net)
    expect(text).toContain('status: SERVFAIL')
    expect(text).toContain('asked its forwarder 203.0.113.54')
  })
})

describe('chains of forwarders', () => {
  const withUpstream = (upstreamForwarder: string) => {
    const net = careConnect()
    const up: NetNode = { id: 'dns2', type: 'device', position: { x: 0, y: 0 }, data: {
      ...makeDefaultData('dns', 'dns2'), label: 'Upstream DNS', ip: '203.0.113.54', gateway: '203.0.113.1', dnsRecords: [], dnsForwarder: upstreamForwarder } }
    net.nodes.push(up)
    net.edges.push({ id: 'd2-e1', source: 'ccsw', target: 'dns2' })
    return setData(net, 'ccdns', { dnsForwarder: '203.0.113.54' })
  }

  it('a forwarder that forwards again: every hop is on the wire', () => {
    const { text, captures } = run('ccweb', 'dig example.com', withUpstream('8.8.8.8'))
    expect(text).toContain('93.184.216.34')
    expect(dnsRows(captures).map((r) => `${r.srcIp}→${r.dstIp}`)).toEqual([
      '203.0.113.80→203.0.113.53', '203.0.113.53→203.0.113.54', '203.0.113.54→8.8.8.8',
      '8.8.8.8→203.0.113.54', '203.0.113.54→203.0.113.53', '203.0.113.53→203.0.113.80',
    ])
  })

  it('two servers that forward to each other: a loop, SERVFAIL', () => {
    const { text } = run('ccweb', 'dig example.com', withUpstream('203.0.113.53'))
    expect(text).toContain('status: SERVFAIL')
    expect(text).toContain('a forwarding loop')
  })
})

describe('no forwarder', () => {
  it('blank: REFUSED for names it does not hold; its own names still work', () => {
    const net = setData(careConnect(), 'ccdns', { dnsForwarder: '' })
    const dig = run('ccweb', 'dig example.com', net)
    expect(dig.text).toContain('status: REFUSED')
    expect(dig.text).toContain("ⓘ REFUSED: DNS Server doesn't hold that name and has no forwarder set")
    expect(dnsRows(dig.captures)).toHaveLength(2)
    expect(run('ccweb', 'nslookup example.com', net).text).toContain("** server can't find example.com: REFUSED")
    expect(run('ccweb', 'ping example.com', net).text).toContain('Temporary failure in name resolution')
    expect(run('ccweb', 'dig www.careconnect.example', net).text).toContain('203.0.113.80')
  })
})
