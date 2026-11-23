import { describe, it, expect } from 'vitest'
import type { PendingCapture } from '../../types'
import { tcpOpen, tcpRefused, tcpClose, dnsLookup, tlsHandshake, certificateFor, formatCertDate, cipherHex, hostKeyFingerprint, EPHEMERAL_MIN, EPHEMERAL_MAX } from '../exchange'
import { httpExchange, parseUrl } from '../protocols/web'
import { ftpSession, sftpSession, portArgument } from '../protocols/files'
import { pop3Session, imapSession, smtpSend, authPlain } from '../protocols/mail'
import { defaultFiles } from '../defaults'
import { run, tcpRecords, careConnect } from './helpers'

/** Group capture records by conversation. */
function byConversation(captures: PendingCapture[]): Map<string, PendingCapture[]> {
  const m = new Map<string, PendingCapture[]>()
  for (const c of captures) m.set(c.conversationId, [...(m.get(c.conversationId) ?? []), c])
  return m
}

describe('TCP and DNS builders', () => {
  it('tcpOpen is SYN, SYN-ACK, ACK in order', () => {
    const s = tcpOpen()
    expect(s.map((x) => [x.dir, x.tcpFlags])).toEqual([['c2s', 'SYN'], ['s2c', 'SYN, ACK'], ['c2s', 'ACK']])
    expect(s.every((x) => x.app === null && x.transport === 'TCP')).toBe(true)
  })
  it('tcpRefused is SYN then RST', () => {
    expect(tcpRefused().map((x) => x.tcpFlags)).toEqual(['SYN', 'RST, ACK'])
  })
  it('tcpClose is FIN both ways', () => {
    expect(tcpClose().map((x) => [x.dir, x.tcpFlags])).toEqual([['c2s', 'FIN, ACK'], ['s2c', 'FIN, ACK']])
  })
  it('dnsLookup is a UDP query and answer (or NXDOMAIN)', () => {
    const ok = dnsLookup('www.careconnect.example', '203.0.113.80')
    expect(ok.map((s) => [s.dir, s.transport, s.app])).toEqual([['c2s', 'UDP', 'DNS'], ['s2c', 'UDP', 'DNS']])
    expect(ok[1]!.info).toContain('203.0.113.80')
    expect(dnsLookup('nope.example', null)[1]!.info).toContain('No such name')
  })
})

describe('web', () => {
  it('parses URLs, keeping the scheme and default ports', () => {
    expect(parseUrl('www.careconnect.example')).toMatchObject({ scheme: 'http', port: 80, path: '/' })
    expect(parseUrl('https://www.careconnect.example/book')).toMatchObject({ scheme: 'https', port: 443, path: '/book', href: 'https://www.careconnect.example/book' })
    expect(parseUrl('http://a.example:8080')).toMatchObject({ port: 8080 })
  })

  it('HTTP steps use server port 80 and are readable', () => {
    const { captures } = run('patient', 'curl http://www.careconnect.example')
    const tcp = tcpRecords(captures)
    expect(tcp.length).toBeGreaterThan(0)
    for (const c of tcp) expect(c.srcPort === 80 || c.dstPort === 80).toBe(true)
    const get = tcp.find((c) => c.app === 'HTTP' && c.info.startsWith('GET'))!
    expect(get.encrypted).toBe(false)
    expect(get.payload).toContain('Host: www.careconnect.example')
    // SYN, SYN-ACK, ACK, GET, 200, FIN, FIN
    expect(tcp.map((c) => c.tcpFlags)).toEqual(['SYN', 'SYN, ACK', 'ACK', 'PSH, ACK', 'PSH, ACK', 'FIN, ACK', 'FIN, ACK'])
  })

  it('HTTPS uses server port 443; ClientHello readable with the server name; application data encrypted', () => {
    const { captures, text } = run('patient', 'curl -v https://www.careconnect.example')
    const tcp = tcpRecords(captures)
    for (const c of tcp) expect(c.srcPort === 443 || c.dstPort === 443).toBe(true)
    const hello = tcp.find((c) => c.info.startsWith('Client Hello'))!
    expect(hello.encrypted).toBe(false)
    expect(hello.payload).toContain('server_name: www.careconnect.example')
    const appData = tcp.filter((c) => c.app !== null && !c.info.startsWith('Client Hello'))
    expect(appData.length).toBe(4) // ServerHello+, Finished, GET, 200
    expect(appData.every((c) => c.encrypted)).toBe(true)
    expect(appData.some((c) => !c.encrypted && /GET|Host:/.test(c.info))).toBe(false)
    expect(text).toContain('* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384')
    expect(text).toContain('ⓘ “SSL” here is a historical name')
  })

  it('httpExchange over TLS marks every step encrypted', () => {
    const steps = httpExchange('h.example', '/', '<p>x</p>', true)
    expect(steps.every((s) => s.encrypted && s.app === 'TLS')).toBe(true)
    expect(httpExchange('h.example', '/', '<p>x</p>', false).every((s) => !s.encrypted && s.app === 'HTTP')).toBe(true)
  })

  it('tlsHandshake: ClientHello in the clear, the rest encrypted', () => {
    const s = tlsHandshake('www.careconnect.example', certificateFor('www.careconnect.example'))
    expect(s[0]!.encrypted).toBeFalsy()
    expect(s[0]!.payload).toContain('www.careconnect.example')
    expect(s.slice(1).every((x) => x.encrypted)).toBe(true)
  })

  it('the demo certificate is dated relative to today', () => {
    const c = certificateFor('h', 'valid', new Date(Date.UTC(2026, 10, 23, 9)))
    expect(formatCertDate(c.start)).toBe('Sep 24 00:00:00 2026 GMT')
    expect(formatCertDate(c.expire)).toBe('Sep 19 23:59:59 2027 GMT')
  })

  it('a stopped service is refused with SYN, RST', () => {
    const net = careConnect()
    net.nodes.find((n) => n.id === 'ccweb')!.data.services = { http: false, https: true }
    const { captures, text } = run('patient', 'curl http://www.careconnect.example', net)
    expect(tcpRecords(captures).map((c) => c.tcpFlags)).toEqual(['SYN', 'RST, ACK'])
    expect(text).toContain("curl: (7) Failed to connect to www.careconnect.example port 80 after 2 ms: Couldn't connect to server")
  })

  it('an unknown name is NXDOMAIN, after the DNS query', () => {
    const { captures, text } = run('patient', 'curl http://wwww.careconnect.example')
    expect(captures.filter((c) => c.app === 'DNS')).toHaveLength(2)
    expect(text).toContain('curl: (6) Could not resolve host: wwww.careconnect.example')
  })
})

describe('FTP and SFTP', () => {
  const files = defaultFiles()
  const ftp = ftpSession({ banner: 'File Server ready', user: 'clinic', password: 'Clinic2026!', clientIp: '10.0.0.11', dataPort: 51550, files, action: { cmd: 'get', file: 'referrals.csv' } })

  it('the PASS step carries the password in the clear', () => {
    const pass = ftp.find((s) => s.label === 'PASS')!
    expect(pass.payload).toBe('PASS Clinic2026!')
    expect(pass.encrypted).toBeFalsy()
  })

  it('the data connection uses server port 20 and carries the file readable', () => {
    const data = ftp.filter((s) => s.serverPort !== undefined)
    expect(data.length).toBeGreaterThan(0)
    expect(data.every((s) => s.serverPort === 20 && s.clientPort === 51550)).toBe(true)
    expect(data[0]).toMatchObject({ dir: 's2c', tcpFlags: 'SYN' }) // active mode: the server connects
    const payload = data.find((s) => s.app === 'FTP-DATA')!
    expect(payload.payload).toContain('P-1043,Sam Okafor,Cardiology')
    expect(payload.encrypted).toBeFalsy()
  })

  it('PORT encodes the data port as p1 × 256 + p2', () => {
    expect(portArgument('192.168.1.101', 51550)).toBe('192,168,1,101,201,94')
  })

  it('a missing file is 550', () => {
    const s = ftpSession({ banner: 'x', user: 'u', password: 'p', clientIp: '1.1.1.1', dataPort: 50000, files, action: { cmd: 'get', file: 'nope.txt' } })
    expect(s.some((x) => x.payload === '550 nope.txt: No such file')).toBe(true)
    expect(s.some((x) => x.app === 'FTP-DATA')).toBe(false)
  })

  it('ftp from the Reception PC: control on 21, data from 20, password visible', () => {
    const { captures, text } = run('reception', 'ftp files.careconnect.example get referrals.csv')
    const ftpRows = captures.filter((c) => c.app === 'FTP' || c.app === 'FTP-DATA')
    expect(ftpRows.some((c) => c.payload === 'PASS Clinic2026!' && c.dstPort === 21)).toBe(true)
    expect(captures.some((c) => c.app === 'FTP-DATA' && c.srcPort === 20 && c.payload?.includes('P-1043,Sam Okafor') === true)).toBe(true)
    expect(text).toContain('226 Transfer complete')
  })

  const sftp = sftpSession({ host: 'files.careconnect.example', ip: '203.0.113.21', user: 'clinic', password: 'Clinic2026!', fingerprint: 'X', files, action: { cmd: 'get', file: 'referrals.csv' } })

  it('SFTP: banners and key exchange readable, everything after encrypted', () => {
    const kexEnd = sftp.findIndex((s) => s.label === 'KEX reply')
    expect(kexEnd).toBe(5)
    expect(sftp.slice(0, kexEnd + 1).every((s) => !s.encrypted)).toBe(true)
    expect(sftp.slice(kexEnd + 1).every((s) => s.encrypted)).toBe(true)
  })

  it('sftp: the password appears nowhere a capture shows it', () => {
    const { captures } = run('reception', 'sftp files.careconnect.example get referrals.csv')
    for (const c of captures) {
      expect(c.info).not.toContain('Clinic2026!')
      if (!c.encrypted) expect(c.payload ?? '').not.toContain('Clinic2026!')
      expect(c.note ?? '').not.toContain('Clinic2026!')
      expect(c.cleartext ?? '').not.toContain('Clinic2026!')
    }
    expect(captures.every((c) => c.app !== 'SSH' || c.dstPort === 22 || c.srcPort === 22)).toBe(true)
  })

  it('the host-key fingerprint is stable per node and 43 characters', () => {
    expect(hostKeyFingerprint('ccfile')).toBe(hostKeyFingerprint('ccfile'))
    expect(hostKeyFingerprint('ccfile')).not.toBe(hostKeyFingerprint('ccweb'))
    expect(hostKeyFingerprint('ccfile')).toHaveLength(43)
  })

  it('a stopped FTP service is refused', () => {
    const net = careConnect()
    net.nodes.find((n) => n.id === 'ccfile')!.data.services = { ftp: false, ssh: true }
    const { captures, text } = run('reception', 'ftp files.careconnect.example get referrals.csv', net)
    expect(tcpRecords(captures).map((c) => c.tcpFlags)).toEqual(['SYN', 'RST, ACK'])
    expect(text).toContain('ftp: connect to address 203.0.113.21: Connection refused')
  })
})

describe('mail', () => {
  it('POP3 removes messages from the server mailbox', () => {
    const { patches, net, text } = run('docpc', 'pop3 dr.nguyen@careconnect.example')
    const mail = net.nodes.find((n) => n.id === 'ccmail')!
    expect(mail.data.mailboxes!.find((b) => b.address.startsWith('dr.nguyen'))!.messages).toHaveLength(0)
    expect(net.nodes.find((n) => n.id === 'docpc')!.data.localMail).toHaveLength(2)
    expect(patches.length).toBe(2)
    expect(text).toContain('Downloaded 2 messages to this device.')
    expect(text).toContain('Deleted 2 messages from the server.')
  })

  it('POP3 --keep leaves them there', () => {
    const { net } = run('docpc', 'pop3 dr.nguyen@careconnect.example --keep')
    expect(net.nodes.find((n) => n.id === 'ccmail')!.data.mailboxes!.find((b) => b.address.startsWith('dr.nguyen'))!.messages).toHaveLength(2)
    expect(net.nodes.find((n) => n.id === 'docpc')!.data.localMail).toHaveLength(2)
  })

  it('a second device then finds nothing', () => {
    const net = careConnect()
    run('docpc', 'pop3 dr.nguyen@careconnect.example', net)
    const { text } = run('doclaptop', 'pop3 dr.nguyen@careconnect.example', net)
    expect(text).toContain('0 messages on the server. Nothing to download.')
  })

  it('POP3 PASS is in the clear on 110, and DELE is skipped with keep', () => {
    const mailbox = { address: 'a@x.example', password: 'pw', messages: [] }
    const s = pop3Session({ address: 'a@x.example', password: 'pw', mailbox, keep: false })
    expect(s.find((x) => x.label === 'PASS')!.payload).toBe('PASS pw')
    const msgs = Array.from({ length: 3 }, (_, i) => ({ id: `${i}`, from: 'f@x.example', to: 'a@x.example', subject: `s${i}`, body: 'b', seen: false }))
    const keep = pop3Session({ address: 'a@x.example', password: 'pw', mailbox: { ...mailbox, messages: msgs }, keep: true })
    expect(keep.some((x) => x.payload?.startsWith('DELE'))).toBe(false)
    // More than two messages: one RETR leg each way
    expect(keep.filter((x) => x.payload?.startsWith('RETR'))).toHaveLength(1)
  })

  it('IMAP never removes, and read sets seen on the server', () => {
    const net = careConnect()
    const { patches } = run('docpc', 'imap dr.nguyen@careconnect.example read 1', net)
    const box = net.nodes.find((n) => n.id === 'ccmail')!.data.mailboxes!.find((b) => b.address.startsWith('dr.nguyen'))!
    expect(box.messages).toHaveLength(2)
    expect(box.messages[0]!.seen).toBe(true)
    expect(box.messages[1]!.seen).toBe(false)
    expect(patches.every((p) => p.id === 'ccmail')).toBe(true)
    expect(net.nodes.find((n) => n.id === 'docpc')!.data.localMail).toEqual([])
    const { text } = run('doclaptop', 'imap dr.nguyen@careconnect.example', net)
    expect(text).toMatch(/1 {2}✓ {5}pathology@careconnect\.example/)
  })

  it('IMAP without read changes nothing', () => {
    const mailbox = { address: 'a@x.example', password: 'pw', messages: [{ id: '1', from: 'f@x.example', to: 'a@x.example', subject: 's', body: 'b', seen: false }] }
    const s = imapSession({ address: 'a@x.example', password: 'pw', mailbox })
    expect(s.some((x) => x.payload?.includes('STORE'))).toBe(false)
    const { patches } = run('docpc', 'imap dr.nguyen@careconnect.example')
    expect(patches).toHaveLength(0)
  })

  it('SMTP AUTH payload is Base64 of \\0user\\0password', () => {
    const steps = smtpSend({ serverHost: 'mail.careconnect.example', clientName: 'reception-pc', from: 'reception@careconnect.example', to: 'dr.nguyen@careconnect.example', subject: 'Hi', password: 'Front2026!', mailDomain: 'careconnect.example', recipientExists: true })
    const auth = steps.find((s) => s.label === 'AUTH PLAIN')!
    const b64 = auth.payload!.replace('AUTH PLAIN ', '')
    expect(atob(b64)).toBe('\u0000reception@careconnect.example\u0000Front2026!')
    expect(b64).toBe(authPlain('reception@careconnect.example', 'Front2026!'))
    expect(auth.note).toBe('Base64 decodes to: \\0reception@careconnect.example\\0Front2026!')
  })

  it('smtp delivers to a local mailbox', () => {
    const net = careConnect()
    const { text } = run('reception', 'smtp reception@careconnect.example dr.nguyen@careconnect.example "Patient arrived"', net)
    expect(text).toContain('250 OK queued')
    const box = net.nodes.find((n) => n.id === 'ccmail')!.data.mailboxes!.find((b) => b.address.startsWith('dr.nguyen'))!
    expect(box.messages).toHaveLength(3)
    expect(box.messages[2]).toMatchObject({ subject: 'Patient arrived', seen: false, body: 'This message was sent from Networx.' })
  })

  it('--tls hides the password: no Base64 note, all application steps encrypted', () => {
    const { captures } = run('reception', 'smtp reception@careconnect.example dr.nguyen@careconnect.example "x" --tls')
    const app = tcpRecords(captures).filter((c) => c.app !== null && !c.info.startsWith('Client Hello'))
    expect(app.every((c) => c.encrypted)).toBe(true)
    expect(captures.some((c) => (c.note ?? '').includes('Front2026!'))).toBe(false)
    expect(tcpRecords(captures).every((c) => c.dstPort === 465 || c.srcPort === 465)).toBe(true)
  })
})

describe('client ports', () => {
  const commands: Array<[string, string]> = [
    ['patient', 'curl http://www.careconnect.example'],
    ['patient', 'curl https://www.careconnect.example'],
    ['reception', 'ftp files.careconnect.example get referrals.csv'],
    ['reception', 'sftp files.careconnect.example ls'],
    ['docpc', 'pop3 dr.nguyen@careconnect.example --keep'],
    ['docpc', 'imap dr.nguyen@careconnect.example read 2'],
    ['reception', 'smtp reception@careconnect.example dr.nguyen@careconnect.example "x"'],
    ['patient', 'nslookup www.careconnect.example'],
  ]

  it.each(commands)('%s: %s — one ephemeral client port per conversation', (node, cmd) => {
    const { captures } = run(node, cmd)
    const convs = byConversation(captures.filter((c) => c.transport === 'TCP' || c.transport === 'UDP'))
    expect(convs.size).toBeGreaterThan(0)
    for (const recs of convs.values()) {
      // The client end of each record: the source when sent by the client, else the destination
      const clientIp = recs[0]!.srcIp
      const ports = new Set(recs
        .filter((r) => r.srcPort !== 20 && r.dstPort !== 20) // FTP's data connection has its own client port
        .map((r) => (r.srcIp === clientIp ? r.srcPort : r.dstPort)))
      expect(ports.size).toBe(1)
      const port = [...ports][0]!
      expect(port).toBeGreaterThanOrEqual(EPHEMERAL_MIN)
      expect(port).toBeLessThanOrEqual(EPHEMERAL_MAX)
    }
  })
})

describe('ciphertext picture', () => {
  it('is deterministic and starts like a TLS record', () => {
    expect(cipherHex('conv-1', 3)).toBe(cipherHex('conv-1', 3))
    expect(cipherHex('conv-1', 3)).not.toBe(cipherHex('conv-1', 4))
    expect(cipherHex('conv-1', 3).startsWith('17 03 03 ')).toBe(true)
    expect(cipherHex('conv-1', 3).endsWith('…')).toBe(true)
  })
})
