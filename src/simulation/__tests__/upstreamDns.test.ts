import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { NetNode, PendingCapture } from '../../types'
import { run, testCtx } from './helpers'
import { PRESETS } from '../presets'
import { normaliseNetwork } from '../defaults'
import { runCommand } from '../terminal'
import * as clock from '../clock'
import {
  cacheArrived, cacheEntries, clearAllDnsCaches, serverCacheId, setDnsCacheClock, subscribeDnsCache,
} from '../dnsCache'

/**
 * The Upstream DNS preset: the Local DNS Server (192.168.1.100) holds no records and forwards to the
 * school.local DNS Server (202.93.169.10). The side panel's DNS Cache tab lists what each cache holds.
 */

let t = 0
beforeEach(() => { t = 0; setDnsCacheClock(() => t) })
afterEach(() => setDnsCacheClock(() => clock.now()))

const upstream = () => {
  clearAllDnsCaches()
  const p = PRESETS.find((x) => x.id === 'upstream-dns')!
  return { nodes: normaliseNetwork(structuredClone(p.nodes), p.edges) as NetNode[], edges: structuredClone(p.edges) }
}
const dnsHops = (c: PendingCapture[]) => c.filter((x) => x.app === 'DNS').sort((a, b) => a.delayMs - b.delayMs)
  .map((r) => `${r.srcIp}→${r.dstIp}`)

describe('Upstream DNS preset', () => {
  it('loads with valid MACs, and the Local DNS Server forwards to 202.93.169.10', () => {
    const net = upstream()
    expect(net.nodes.every((n) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(n.data.mac))).toBe(true)
    const local = net.nodes.find((n) => n.id === 'dns1')!
    expect(local.data.dnsForwarder).toBe('202.93.169.10')
    expect(local.data.dnsRecords).toEqual([])
  })

  it('nslookup www.school.local: the Local DNS Server asks 202.93.169.10, then answers from its cache', () => {
    const net = upstream()
    const first = run('pc1', 'nslookup www.school.local', net)
    expect(first.text).toContain('Non-authoritative answer:')
    expect(first.text).toContain('203.93.169.26')
    expect(dnsHops(first.captures)).toEqual([
      '192.168.1.101→192.168.1.100', '192.168.1.100→202.93.169.10', '202.93.169.10→192.168.1.100', '192.168.1.100→192.168.1.101',
    ])
    // Work PC uses the same DNS server: answered from the server's cache, nothing sent upstream
    t = 100_000
    const second = run('pc2', 'nslookup www.school.local', net)
    expect(second.text).toContain('203.93.169.26')
    expect(dnsHops(second.captures)).toEqual(['192.168.1.12→192.168.1.100', '192.168.1.100→192.168.1.12'])
    const served = cacheArrived(serverCacheId('dns1'))
    expect(served.map((e) => [e.name, e.qtype, e.serverIp, e.remaining])).toEqual([['www.school.local', 'A', '202.93.169.10', 3500]])
  })

  it('the web page loads by name from the Desktop PC', () => {
    expect(run('pc1', 'curl http://www.school.local', upstream()).text).toContain('Welcome to My Web Server')
  })

  it('school.local DNS Server switched off: SERVFAIL, after the cache is flushed', () => {
    const net = upstream()
    run('pc1', 'nslookup www.school.local', net)
    const off = net.nodes.find((n) => n.id === 'dns2')!
    off.data = { ...off.data, isOn: false }
    expect(run('pc2', 'nslookup www.school.local', net).text).toContain('203.93.169.26')   // still cached
    run('dns1', 'flushdns', net)
    expect(run('pc2', 'nslookup www.school.local', net).text).toContain("** server can't find www.school.local: SERVFAIL")
  })
})

describe('the DNS Cache tab', () => {
  it("lists an answer only once its packet has arrived: the server's first, then the PC's", () => {
    const net = upstream()
    const scheduled: Array<{ ms: number; fn: () => void }> = []
    const { ctx } = testCtx('pc1', net)
    ctx.schedule = (ms, fn) => { scheduled.push({ ms, fn }) }
    runCommand('curl http://www.school.local', ctx)
    // Cached at once (a following command uses it) …
    expect(cacheEntries('pc1')).toHaveLength(1)
    expect(cacheEntries(serverCacheId('dns1'))).toHaveLength(1)
    // … but listed only when the answer's packet gets there
    expect(cacheArrived('pc1')).toHaveLength(0)
    expect(cacheArrived(serverCacheId('dns1'))).toHaveLength(0)
    let serverAt = -1, pcAt = -1
    for (const s of [...scheduled].sort((a, b) => a.ms - b.ms)) {
      s.fn()
      if (serverAt < 0 && cacheArrived(serverCacheId('dns1')).length) serverAt = s.ms
      if (pcAt < 0 && cacheArrived('pc1').length) pcAt = s.ms
    }
    expect(serverAt).toBeGreaterThan(0)
    expect(pcAt).toBeGreaterThan(serverAt)
    expect(cacheArrived('pc1').map((e) => [e.name, e.serverIp])).toEqual([['www.school.local', '192.168.1.100']])
  })

  it('nslookup asks the DNS server directly: only the server caches the answer', () => {
    run('pc1', 'nslookup www.school.local', upstream())
    expect(cacheArrived('pc1')).toHaveLength(0)
    expect(cacheArrived(serverCacheId('dns1'))).toHaveLength(1)
  })

  it('an answer already cached stays listed while dig asks again', () => {
    const net = upstream()
    run('pc1', 'curl http://www.school.local', net)
    t = 5_000
    const { ctx } = testCtx('pc1', net)
    ctx.schedule = () => {}   // the answer never "arrives" in this test
    runCommand('dig www.school.local', ctx)
    expect(cacheArrived('pc1')).toHaveLength(1)
  })

  it('tells the panel when a cache changes', () => {
    const net = upstream()
    let calls = 0
    const off = subscribeDnsCache(() => { calls++ })
    run('pc1', 'curl http://www.school.local', net)
    const afterLookup = calls
    expect(afterLookup).toBeGreaterThan(0)
    run('pc1', 'flushdns', net)
    expect(calls).toBeGreaterThan(afterLookup)
    const afterFlush = calls
    off()
    run('pc1', 'curl http://www.school.local', net)
    expect(calls).toBe(afterFlush)
  })
})
