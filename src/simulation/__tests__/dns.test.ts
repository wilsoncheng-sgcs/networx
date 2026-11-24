import { describe, it, expect } from 'vitest'
import type { DnsRecord, NetNode } from '../../types'
import { run, careConnect } from './helpers'
import { normaliseNode } from '../defaults'
import { answerQuery, normaliseRecord, validateRecord, messageSize, isIpv6 } from '../dns'

const rec = (name: string, type: DnsRecord['type'], value: string, ttl = 3600, priority?: number): DnsRecord =>
  ({ id: `${name}-${type}-${value}`, name, type, value, ttl, ...(priority !== undefined ? { priority } : {}) })
const noElsewhere = () => []

describe('B2 — records', () => {
  it('an old { hostname, ip } record becomes an A record with TTL 3600', () => {
    expect(normaliseRecord({ id: 'x', hostname: 'www.local', ip: '192.168.1.80' } as never))
      .toEqual({ id: 'x', name: 'www.local', type: 'A', value: '192.168.1.80', ttl: 3600 })
  })

  it('a network saved before Phase 4 still resolves its names', () => {
    const net = careConnect()
    const dns = net.nodes.find((n) => n.id === 'ccdns')!
    const old = { ...dns, data: { ...dns.data, dnsRecords: [{ id: 'o1', hostname: 'old.careconnect.example', ip: '203.0.113.80' }] } } as unknown as NetNode
    net.nodes = net.nodes.map((n) => (n.id === 'ccdns' ? normaliseNode(old) : n))
    expect(run('patient', 'curl http://old.careconnect.example', net).text).toContain('CareConnect Medical Centre')
  })

  it('validates each type, the TTL, MX priority, and CNAME exclusivity', () => {
    const zone = [rec('careconnect.example', 'A', '203.0.113.80'), rec('www.careconnect.example', 'CNAME', 'careconnect.example', 300)]
    expect(validateRecord(rec('portal.careconnect.example', 'A', '203.0.113.80'), zone)).toBeNull()
    expect(validateRecord(rec('portal.careconnect.example', 'A', '203.0.113.300'), zone)).toMatch(/IPv4/)
    expect(validateRecord(rec('portal.careconnect.example', 'AAAA', '203.0.113.80'), zone)).toMatch(/IPv6/)
    expect(validateRecord(rec('v6.careconnect.example', 'AAAA', '2001:db8:cc::80'), zone)).toBeNull()
    expect(validateRecord(rec('x.careconnect.example', 'CNAME', 'not a name'), zone)).toMatch(/host name/)
    expect(validateRecord(rec('x.careconnect.example', 'A', '203.0.113.80', 90000), zone)).toMatch(/TTL/)
    expect(validateRecord(rec('x.careconnect.example', 'A', '203.0.113.80', 1.5), zone)).toMatch(/TTL/)
    expect(validateRecord(rec('careconnect.example', 'MX', 'mail.careconnect.example', 3600, -1), zone)).toMatch(/Priority/)
    expect(validateRecord(rec('careconnect.example', 'CNAME', 'other.example'), zone)).toMatch(/CNAME/)
    expect(validateRecord(rec('www.careconnect.example', 'A', '203.0.113.80'), zone)).toMatch(/alias/)
    expect(validateRecord(rec('bad name', 'A', '203.0.113.80'), zone)).toMatch(/Name/)
  })

  it('knows a valid IPv6 address', () => {
    for (const ok of ['2001:db8:cc::80', '::1', 'fe80::1', '2001:0db8:0000:0000:0000:ff00:0042:8329']) expect(isIpv6(ok), ok).toBe(true)
    for (const bad of ['2001:db8:::1', '1:2:3:4:5:6:7:8:9', 'g::1', '203.0.113.80', '']) expect(isIpv6(bad), bad).toBe(false)
  })
})

describe('B2 — answering', () => {
  const zone = careConnect().nodes.find((n) => n.id === 'ccdns')!.data.dnsRecords

  it('follows a CNAME: www → careconnect.example → A, with both TTLs', () => {
    const a = answerQuery(zone, noElsewhere, 'www.careconnect.example', 'A')
    expect(a.status).toBe('NOERROR')
    expect(a.authoritative).toBe(true)
    expect(a.records.map((r) => [r.name, r.type, r.value, r.ttl])).toEqual([
      ['www.careconnect.example', 'CNAME', 'careconnect.example', 300],
      ['careconnect.example', 'A', '203.0.113.80', 3600],
    ])
  })

  it('an A query for a name with only an AAAA is NOERROR with an empty answer, not NXDOMAIN', () => {
    const z = [...zone, rec('v6.careconnect.example', 'AAAA', '2001:db8:cc::99')]
    expect(answerQuery(z, noElsewhere, 'v6.careconnect.example', 'A')).toMatchObject({ status: 'NOERROR', records: [] })
    expect(answerQuery(z, noElsewhere, 'nope.careconnect.example', 'A').status).toBe('NXDOMAIN')
  })

  it('a CNAME loop is SERVFAIL', () => {
    const z = [rec('a.example', 'CNAME', 'b.example'), rec('b.example', 'CNAME', 'a.example')]
    expect(answerQuery(z, noElsewhere, 'a.example', 'A').status).toBe('SERVFAIL')
  })

  it('MX, NS and TXT answers', () => {
    expect(answerQuery(zone, noElsewhere, 'careconnect.example', 'MX').records).toMatchObject([{ type: 'MX', value: 'mail.careconnect.example', priority: 10 }])
    expect(answerQuery(zone, noElsewhere, 'careconnect.example', 'NS').records).toMatchObject([{ type: 'NS', value: 'ns1.careconnect.example' }])
    expect(answerQuery(zone, noElsewhere, 'careconnect.example', 'TXT').records).toMatchObject([{ type: 'TXT', value: '"v=spf1 mx -all"' }])
  })

  it('message size counts compressed names (CNAME + A ≈ the spec example)', () => {
    const a = answerQuery(zone, noElsewhere, 'www.careconnect.example', 'A')
    expect(messageSize('www.careconnect.example', a.records)).toBeGreaterThan(70)
    expect(messageSize('www.careconnect.example', a.records)).toBeLessThan(100)
  })
})

describe('B2 — connections with the new records', () => {
  it('curl through the www CNAME works; the DNS response row shows the CNAME then the A', () => {
    const { text, captures } = run('patient', 'curl http://www.careconnect.example')
    expect(text).toContain('CareConnect Medical Centre')
    const dns = captures.filter((c) => c.app === 'DNS')
    expect(dns).toHaveLength(2)
    expect(dns[0]!.info).toMatch(/^Standard query 0x[0-9a-f]{4} A www\.careconnect\.example$/)
    expect(dns[1]!.info).toMatch(/^Standard query response 0x[0-9a-f]{4} A www\.careconnect\.example CNAME careconnect\.example A 203\.0\.113\.80$/)
    expect(dns[0]!.info.split(' ')[2]).toBe(dns[1]!.info.split(' ')[3])   // same transaction id
  })

  it('a name with only an AAAA record: could not resolve, and why', () => {
    const net = careConnect()
    const dns = net.nodes.find((n) => n.id === 'ccdns')!
    dns.data = { ...dns.data, dnsRecords: [...dns.data.dnsRecords, rec('v6.careconnect.example', 'AAAA', '2001:db8:cc::99')] }
    const { text } = run('patient', 'curl http://v6.careconnect.example', net)
    expect(text).toContain('curl: (6) Could not resolve host: v6.careconnect.example')
    expect(text).toContain('ⓘ This name only has an IPv6 address (AAAA record); Networx connects over IPv4 only.')
  })
})
