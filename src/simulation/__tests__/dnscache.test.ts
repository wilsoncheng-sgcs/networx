import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { run, careConnect } from './helpers'
import { setDnsCacheClock } from '../dnsCache'
import * as clock from '../clock'

let t = 0
beforeEach(() => { t = 0; setDnsCacheClock(() => t) })
afterEach(() => setDnsCacheClock(() => clock.now()))
const dnsRows = (c: { app: string | null }[]) => c.filter((x) => x.app === 'DNS')

describe('B4 — the device DNS cache honours TTL', () => {
  it('a second dig is answered from the cache: no packets, a lower TTL, and the cache note', () => {
    const net = careConnect()
    const first = run('patient', 'dig careconnect.example', net)
    expect(dnsRows(first.captures)).toHaveLength(2)
    expect(first.text).toMatch(/careconnect\.example\. +3600\tIN\tA/)
    t = 5000
    const second = run('patient', 'dig careconnect.example', net)
    expect(dnsRows(second.captures)).toHaveLength(0)
    expect(second.text).toMatch(/careconnect\.example\. +3595\tIN\tA\t203\.0\.113\.80/)
    expect(second.text).toContain("ⓘ Answered from this device's cache — nothing was sent. It stays cached until the TTL runs out.")
    expect(second.text).toContain(';; flags: qr rd ra;')
    expect(second.text).toContain(';; Query time: 0 msec')
  })

  it('editing a record does not reach a device that cached it — until flushdns', () => {
    const net = careConnect()
    run('patient', 'dig careconnect.example', net)
    const dns = net.nodes.find((n) => n.id === 'ccdns')!
    dns.data = { ...dns.data, dnsRecords: dns.data.dnsRecords.map((r) => (r.id === 'cc1' ? { ...r, value: '203.0.113.25' } : r)) }
    t = 10_000
    expect(run('patient', 'dig careconnect.example', net).text).toContain('203.0.113.80')
    expect(run('patient', 'flushdns', net).text).toContain("Flushed the DNS cache on Patient's Laptop")
    const fresh = run('patient', 'dig careconnect.example', net)
    expect(fresh.text).toContain('203.0.113.25')
    expect(dnsRows(fresh.captures)).toHaveLength(2)
  })

  it('an entry expires when its shortest TTL runs out (www: the CNAME\'s 300 s)', () => {
    const net = careConnect()
    run('patient', 'curl http://www.careconnect.example', net)
    t = 299_000
    expect(dnsRows(run('patient', 'curl http://www.careconnect.example', net).captures)).toHaveLength(0)
    t = 300_000
    expect(dnsRows(run('patient', 'curl http://www.careconnect.example', net).captures)).toHaveLength(2)
  })

  it('NXDOMAIN is cached for 60 s', () => {
    const net = careConnect()
    run('patient', 'dig nope.careconnect.example', net)
    t = 59_000
    const cached = run('patient', 'dig nope.careconnect.example', net)
    expect(dnsRows(cached.captures)).toHaveLength(0)
    expect(cached.text).toContain('status: NXDOMAIN')
    t = 60_000
    expect(dnsRows(run('patient', 'dig nope.careconnect.example', net).captures)).toHaveLength(2)
  })

  it('curl after dig uses the cache; curl -v says so', () => {
    const net = careConnect()
    run('patient', 'dig www.careconnect.example', net)
    const { text, captures } = run('patient', 'curl -v http://www.careconnect.example', net)
    expect(dnsRows(captures)).toHaveLength(0)
    expect(text).toContain("ⓘ DNS: www.careconnect.example → 203.0.113.80 from this device's DNS cache (nothing sent)")
    expect(text).toContain('CareConnect Medical Centre')
  })

  it('each device has its own cache', () => {
    const net = careConnect()
    run('patient', 'dig careconnect.example', net)
    expect(dnsRows(run('reception', 'dig careconnect.example', net).captures)).toHaveLength(2)
  })

  it('dnscache lists the entries with the time left; ipconfig /displaydns too', () => {
    const net = careConnect()
    run('patient', 'curl http://www.careconnect.example', net)
    run('patient', 'dig careconnect.example MX', net)
    t = 20_000
    const { text } = run('patient', 'dnscache', net)
    expect(text).toMatch(/www\.careconnect\.example +A +280 s +careconnect\.example\. \(CNAME\), 203\.0\.113\.80/)
    expect(text).toMatch(/careconnect\.example +MX +3580 s +10 mail\.careconnect\.example\./)
    expect(run('patient', 'ipconfig /displaydns', net).text).toContain('www.careconnect.example')
    expect(run('reception', 'dnscache', net).text).toContain('is empty')
  })

  it('sudo dscacheutil -flushcache (macOS) and ipconfig /flushdns (Windows) empty it', () => {
    const net = careConnect()
    run('patient', 'dig careconnect.example', net)
    expect(run('patient', 'sudo dscacheutil -flushcache', net).lines).toHaveLength(0)
    expect(run('patient', 'dnscache', net).text).toContain('is empty')
    run('patient', 'dig careconnect.example', net)
    expect(run('patient', 'ipconfig /flushdns', net).text).toContain('Successfully flushed the DNS Resolver Cache.')
    expect(run('patient', 'dnscache', net).text).toContain('is empty')
  })

  it('nslookup asks the server every time (it does not use the device cache)', () => {
    const net = careConnect()
    run('patient', 'dig www.careconnect.example', net)
    expect(dnsRows(run('patient', 'nslookup www.careconnect.example', net).captures)).toHaveLength(2)
  })
})
