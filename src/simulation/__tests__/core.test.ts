import { describe, it, expect } from 'vitest'
import { SERVICES, serviceById, isListening, listeningServices, type ServiceId } from '../services'
import { tokenize } from '../tokenize'
import { resolveTarget, isResolveError } from '../resolve'
import { normaliseNode, makeDefaultData } from '../defaults'
import type { NetNode } from '../../types'
import { careConnect, testCtx } from './helpers'
import { PRESETS } from '../presets'

describe('services table (spec §2.2)', () => {
  const expected: Array<[ServiceId, string, 'TCP' | 'UDP', number, boolean]> = [
    ['dns', 'DNS', 'UDP', 53, false],
    ['http', 'HTTP', 'TCP', 80, false],
    ['https', 'HTTPS', 'TCP', 443, true],
    ['ftp', 'FTP', 'TCP', 21, false],
    ['ssh', 'SSH / SFTP', 'TCP', 22, true],
    ['smtp', 'SMTP', 'TCP', 25, false],
    ['submission', 'SMTP', 'TCP', 587, false],
    ['smtps', 'SMTP over TLS', 'TCP', 465, true],
    ['pop3', 'POP3', 'TCP', 110, false],
    ['pop3s', 'POP3 over TLS', 'TCP', 995, true],
    ['imap', 'IMAP', 'TCP', 143, false],
    ['imaps', 'IMAP over TLS', 'TCP', 993, true],
  ]

  it('has exactly the twelve services', () => {
    expect(SERVICES.map((s) => s.id).sort()).toEqual(expected.map((e) => e[0]).sort())
  })

  it.each(expected)('%s: %s over %s port %i, secure=%s', (id, protocol, transport, port, secure) => {
    const s = serviceById(id)
    expect(s.protocol).toBe(protocol)
    expect(s.transport).toBe(transport)
    expect(s.port).toBe(port)
    expect(s.secure).toBe(secure)
  })

  const node = (type: NetNode['data']['deviceType'], patch: Partial<NetNode['data']> = {}): NetNode =>
    ({ id: 'n', type: 'device', position: { x: 0, y: 0 }, data: { ...makeDefaultData(type, 'n-1'), ...patch } })

  it('isListening uses the type defaults', () => {
    expect(isListening(node('web'), 'http')).toBe(true)
    expect(isListening(node('web'), 'ftp')).toBe(false)
    expect(isListening(node('file'), 'ftp')).toBe(true)
    expect(isListening(node('pc'), 'ssh')).toBe(false)
    expect(listeningServices(node('pc'))).toEqual([])
  })

  it('isListening honours overrides', () => {
    expect(isListening(node('file', { services: { ftp: false } }), 'ftp')).toBe(false)
    expect(isListening(node('web', { services: { ftp: true } }), 'ftp')).toBe(true)
  })

  it('an off device listens on nothing', () => {
    expect(isListening(node('web', { isOn: false }), 'http')).toBe(false)
  })

  it('internet hosts answer HTTP and HTTPS only', () => {
    expect(isListening(node('cloud'), 'https')).toBe(true)
    expect(isListening(node('cloud'), 'ftp')).toBe(false)
  })
})

describe('tokenizer', () => {
  it('keeps a double-quoted argument together', () => {
    expect(tokenize('smtp a@x.example b@x.example "Test results ready"')).toEqual([
      'smtp', 'a@x.example', 'b@x.example', 'Test results ready',
    ])
  })
  it('splits on any whitespace', () => {
    expect(tokenize('  curl   -v\thttp://a  ')).toEqual(['curl', '-v', 'http://a'])
  })
  it('an unmatched quote takes the rest of the line', () => {
    expect(tokenize('smtp a b "Patient arrived late')).toEqual(['smtp', 'a', 'b', 'Patient arrived late'])
  })
})

describe('resolveTarget (spec §2.5)', () => {
  it('answers a local A record authoritatively', () => {
    const { ctx } = testCtx('patient')
    const r = resolveTarget('WWW.careconnect.example', ctx)
    expect(isResolveError(r)).toBe(false)
    if (isResolveError(r)) return
    expect(r.ip).toBe('203.0.113.80')
    expect(r.node?.id).toBe('ccweb')
    expect(r.dnsServerNode?.id).toBe('ccdns')
    expect(r.authoritative).toBe(true)
  })

  it('answers a public name non-authoritatively, reached through the internet node', () => {
    const { ctx } = testCtx('patient')
    const r = resolveTarget('example.com', ctx)
    if (isResolveError(r)) throw new Error('expected an answer')
    expect(r.ip).toBe('93.184.216.34')
    expect(r.authoritative).toBe(false)
    expect(r.node?.data.deviceType).toBe('cloud')
  })

  it('returns NXDOMAIN for an unknown name — never a random address', () => {
    const { ctx } = testCtx('patient')
    for (let i = 0; i < 20; i++) {
      const r = resolveTarget('wwww.careconnect.example', ctx)
      expect(isResolveError(r) && r.error).toBe('nxdomain')
      expect('ip' in r).toBe(false)
    }
  })

  it("times out when the DNS server can't be reached (never falls back to another server)", () => {
    const net = careConnect()
    net.edges = net.edges.filter((e) => e.id !== 'cc-e2') // unplug the home gateway from the internet
    const { ctx } = testCtx('patient', net)
    const r = resolveTarget('www.careconnect.example', ctx)
    expect(isResolveError(r) && r.error).toBe('timeout')
  })

  it('errors with no DNS server and no internet', () => {
    const preset = PRESETS.find((p) => p.id === 'star-lan')!
    const net = { nodes: structuredClone(preset.nodes).map(normaliseNode), edges: structuredClone(preset.edges) }
    const { ctx } = testCtx('pc1', net)
    const r = resolveTarget('www.example.com', ctx)
    expect(isResolveError(r) && r.error).toBe('no-dns')
  })

  it('an IP needs no DNS', () => {
    const { ctx } = testCtx('patient')
    const r = resolveTarget('203.0.113.21', ctx)
    if (isResolveError(r)) throw new Error('expected an answer')
    expect(r.node?.id).toBe('ccfile')
    expect(r.dnsServerNode).toBeNull()
  })
})

describe('normaliseNode', () => {
  it('fills every new field on a node saved by the upstream version', () => {
    // Shape of a node in a network.json exported from the live site before this branch
    const upstream = {
      id: 'web-101', type: 'device', position: { x: 10, y: 20 },
      data: {
        label: 'Web Server', deviceType: 'web', ip: '192.168.1.80', wanIp: '', subnet: '255.255.255.0',
        gateway: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff', isOn: true, routingTable: [], dhcpEnabled: false,
        dhcpPool: '100-200', macTable: [], arpTable: [], ssid: 'NetworX-WiFi', wpaKey: 'password123',
        band: '2.4GHz', rules: [], dnsRecords: [], pageContent: '<h1>Mine</h1>', termHistory: [], notes: '',
      },
    } as unknown as NetNode
    const n = normaliseNode(upstream)
    expect(n.data.services).toEqual({})
    expect(n.data.localMail).toEqual([])
    expect(n.data.certificate).toBe('valid')
    expect(n.data.redirectHttp).toBe(false)
    // Existing values win
    expect(n.data.ip).toBe('192.168.1.80')
    expect(n.data.mac).toBe('aa:bb:cc:dd:ee:ff')
    expect(n.data.pageContent).toBe('<h1>Mine</h1>')
    expect(n.position).toEqual({ x: 10, y: 20 })
  })

  it('fills mail and file defaults and tolerates very old nodes', () => {
    const old = { id: 'x', type: 'device', position: { x: 0, y: 0 }, data: { label: 'F', deviceType: 'file', ip: '1.2.3.4', isOn: true } } as unknown as NetNode
    const n = normaliseNode(old)
    expect(n.data.files?.map((f) => f.name)).toEqual(['readme.txt', 'referrals.csv'])
    expect(n.data.account).toEqual({ user: 'clinic', password: 'Clinic2026!' })
    expect(n.data.rules).toEqual([])
    expect(n.data.termHistory).toEqual([])
    const m = normaliseNode({ ...old, data: { ...old.data, deviceType: 'mail' } } as NetNode)
    expect(m.data.mailDomain).toBe('example.local')
    expect(m.data.mailboxes?.[0]?.address).toBe('user@example.local')
  })
})
