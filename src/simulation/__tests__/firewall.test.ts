import { describe, it, expect } from 'vitest'
import type { FirewallRule, NetNode } from '../../types'
import { run, careConnect } from './helpers'
import { PRESETS } from '../presets'
import { makeDefaultData, normaliseNode } from '../defaults'
import { routeBetween, type Flow } from '../routing'

type Net = ReturnType<typeof careConnect>
const rule = (direction: 'in' | 'out', protocol: FirewallRule['protocol'], port: string, action: 'allow' | 'deny', srcIp = '*', dstIp = '*'): FirewallRule =>
  ({ id: `${direction}${protocol}${port}${action}${srcIp}`, direction, protocol, port, action, srcIp, dstIp })

/** The lesson set-up: a firewall between the internet and CareConnect's router, with the default rules. */
function withFirewall(rules?: FirewallRule[]): Net {
  const net = careConnect()
  const fw: NetNode = { id: 'ccfw', type: 'device', position: { x: 430, y: 90 }, data: { ...makeDefaultData('firewall', 'ccfw'), label: 'CareConnect Firewall', ip: '198.51.100.2' } }
  if (rules) fw.data.rules = rules
  net.nodes.push(fw)
  net.edges = net.edges.filter((e) => e.id !== 'cc-e3')
  net.edges.push({ id: 'fw-e1', source: 'net', target: 'ccfw' }, { id: 'fw-e2', source: 'ccfw', target: 'ccrouter' })
  return net
}
const setRules = (net: Net, id: string, rules: FirewallRule[]) => {
  const n = net.nodes.find((x) => x.id === id)!
  n.data = { ...n.data, rules }
  return net
}

describe('default rules (spec §8)', () => {
  it('a new gateway denies everything inbound; a new firewall lets in SSH, HTTPS and HTTP only', () => {
    expect(makeDefaultData('gateway', 'g-1').rules.map((r) => `${r.direction} ${r.protocol} ${r.port} ${r.action}`)).toEqual(['in ANY * deny'])
    expect(makeDefaultData('firewall', 'f-1').rules.map((r) => `${r.direction} ${r.protocol} ${r.port} ${r.action}`))
      .toEqual(['in TCP 22 allow', 'in TCP 443 allow', 'in TCP 80 allow', 'in ANY * deny'])
  })
})

describe('a firewall in front of CareConnect (default rules)', () => {
  it('lets in HTTP, HTTPS and SSH from the internet', () => {
    expect(run('reception', 'curl http://203.0.113.80', withFirewall()).text).toContain('CareConnect Medical Centre')
    expect(run('reception', 'curl -k https://203.0.113.80', withFirewall()).text).toContain('CareConnect Medical Centre')
    expect(run('reception', 'sftp 203.0.113.21 ls', withFirewall()).text).toContain('referrals.csv')
  })

  it('drops FTP: the SYN stops at the firewall three times, and ftp times out', () => {
    const { text, captures } = run('reception', 'ftp 203.0.113.21 ls', withFirewall())
    expect(text).toContain('ftp: connect: Operation timed out')
    expect(text).toContain("CareConnect Firewall's firewall dropped it: rule 4 (in ANY * deny)")
    expect(text).toContain('inbound')
    const syns = captures.filter((c) => c.tcpFlags === 'SYN')
    expect(syns).toHaveLength(3)
    expect(syns.every((c) => c.route?.slice(-1)[0] === 'ccfw' && c.dstPort === 21)).toBe(true)
    expect(captures.some((c) => c.tcpFlags === 'SYN, ACK' || c.tcpFlags === 'RST, ACK')).toBe(false)
  })

  it('curl through a denied port: curl (28) timeout, not refused', () => {
    const net = withFirewall([rule('in', 'TCP', '80', 'deny'), rule('in', 'ANY', '*', 'allow')])
    expect(run('reception', 'curl http://203.0.113.80', net).text).toContain('curl: (28) Failed to connect to 203.0.113.80 port 80 after 75000 ms: Timeout was reached')
  })

  it('DNS queries (UDP 53) are dropped too: names time out until UDP 53 is allowed', () => {
    const blocked = run('reception', 'nslookup www.careconnect.example', withFirewall()).text
    expect(blocked).toContain(';; connection timed out; no servers could be reached')
    expect(blocked).toContain('dropped it')
    const net = withFirewall([rule('in', 'UDP', '53', 'allow'), ...makeDefaultData('firewall', 'x').rules])
    expect(run('reception', 'nslookup www.careconnect.example', net).text).toContain('203.0.113.80')
  })

  it('the lesson: in TCP 21 deny above an allow — SFTP still works, FTP is dropped', () => {
    const net = () => withFirewall([rule('in', 'TCP', '21', 'deny'), rule('in', 'ANY', '*', 'allow')])
    expect(run('reception', 'ftp files.careconnect.example ls', net()).text).toContain('ftp: connect: Operation timed out')
    expect(run('reception', 'sftp files.careconnect.example ls', net()).text).toContain('referrals.csv')
    // Rule order matters: with the allow first, FTP gets through
    const allowFirst = withFirewall([rule('in', 'ANY', '*', 'allow'), rule('in', 'TCP', '21', 'deny')])
    expect(run('reception', 'ftp files.careconnect.example ls', allowFirst).text).toContain('referrals.csv')
  })

  it('outbound connections from the servers, and the replies, are allowed', () => {
    expect(run('ccweb', 'ping example.com', withFirewall()).text).toContain('64 bytes from')
  })

  it("matches the source address the firewall sees: a private sender behind NAT is its gateway's public address", () => {
    const net = () => withFirewall([rule('in', 'TCP', '80', 'deny', '198.51.100.23'), rule('in', 'ANY', '*', 'allow')])
    expect(run('patient', 'curl http://203.0.113.80', net()).text).toContain('Timeout was reached')
    expect(run('reception', 'curl http://203.0.113.80', net()).text).toContain('CareConnect Medical Centre')
    const byPrivate = withFirewall([rule('in', 'TCP', '80', 'deny', '192.168.1.101'), rule('in', 'ANY', '*', 'allow')])
    expect(run('patient', 'curl http://203.0.113.80', byPrivate).text).toContain('CareConnect Medical Centre')
  })
})

describe('gateway rules', () => {
  const homeDefault = () => setRules(careConnect(), 'homegw', makeDefaultData('gateway', 'x').rules)

  it('in ANY deny: the patient still browses and pings out (outbound, and replies get back in)', () => {
    expect(run('patient', 'curl http://www.careconnect.example', homeDefault()).text).toContain('CareConnect Medical Centre')
    expect(run('patient', 'ping example.com', homeDefault()).text).toContain('64 bytes from')
  })

  it("in ANY deny: a ping from the internet to the gateway's public address is dropped", () => {
    const { text } = run('reception', 'ping 198.51.100.23', homeDefault())
    expect(text).toContain('Request timeout for icmp_seq 0')
    expect(text).toContain("Home Gateway's firewall dropped it")
  })

  it('the LAN side is not filtered', () => {
    expect(run('patient', 'ping 192.168.1.1', homeDefault()).text).toContain('64 bytes from 192.168.1.1')
  })

  it('an outbound rule blocks what the LAN starts', () => {
    const block = () => setRules(careConnect(), 'homegw', [rule('out', 'ICMP', '*', 'deny')])
    expect(run('patient', 'ping example.com', block()).text).toContain('Request timeout')
    expect(run('patient', 'curl http://www.careconnect.example', block()).text).toContain('CareConnect Medical Centre')
  })

  it('traceroute stops before the firewall that drops it', () => {
    const net = withFirewall([rule('in', 'ICMP', '*', 'deny'), rule('in', 'ANY', '*', 'allow')])
    const { text } = run('reception', 'traceroute 203.0.113.80', net)
    expect(text).toContain('Exchange point')
    expect(text).toContain('* * *')
    expect(text).not.toContain('CareConnect Router')
  })
})

describe('every preset behaves as before', () => {
  it("the presets' own rules change nothing that a device on them can start", () => {
    const flows: Flow[] = [{ protocol: 'ICMP' }, { protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }, { protocol: 'UDP', port: 53 }]
    for (const p of PRESETS) {
      const nodes = structuredClone(p.nodes).map(normaliseNode)
      for (const a of nodes) for (const b of nodes) {
        if (a.id === b.id || a.data.deviceType === 'cloud' || !b.data.ip || b.data.ip === '0.0.0.0') continue
        const plain = routeBetween(a, b, b.data.ip, nodes, p.edges)
        for (const f of flows) {
          expect(routeBetween(a, b, b.data.ip, nodes, p.edges, f).ok, `${p.id} ${a.id} → ${b.id} ${f.protocol}`).toBe(plain.ok)
        }
      }
    }
  })
})
