import { describe, it, expect } from 'vitest'
import type { CertificateState } from '../../types'
import { certificateFor, certProblem, formatCertDate, WRONG_CERT_NAME } from '../exchange'
import { parseCurlFlags } from '../protocols/web'
import { tapView, tapLabel } from '../tap'
import { run, tcpRecords, careConnect } from './helpers'

const HOST = 'www.careconnect.example'

/** CareConnect with the web (and mail) server's certificate set. */
function withCert(state: CertificateState) {
  const net = careConnect()
  for (const id of ['ccweb', 'ccmail']) net.nodes.find((n) => n.id === id)!.data.certificate = state
  return net
}

describe('certificate states (spec §3.3)', () => {
  const today = new Date(Date.UTC(2026, 10, 24, 9))

  it('valid: issued to the host by the demo CA, and passes the check', () => {
    const c = certificateFor(HOST, 'valid', today)
    expect(c.subject).toBe(`CN=${HOST}`)
    expect(c.issuer).toBe('CN=Networx Demo CA')
    expect(certProblem(c, HOST)).toBeNull()
  })

  it('self-signed: issuer = subject', () => {
    const c = certificateFor(HOST, 'self-signed', today)
    expect(c.issuer).toBe(c.subject)
    expect(certProblem(c, HOST)?.curl).toBe('curl: (60) SSL certificate problem: self-signed certificate')
  })

  it('expired: the expiry date is in the past', () => {
    const c = certificateFor(HOST, 'expired', today)
    expect(c.expire.getTime()).toBeLessThan(today.getTime())
    expect(c.start.getTime()).toBeLessThan(c.expire.getTime())
    expect(formatCertDate(c.expire)).toBe('Sep 25 23:59:59 2026 GMT')
    expect(certProblem(c, HOST)?.curl).toBe('curl: (60) SSL certificate problem: certificate has expired')
  })

  it('wrong-name: issued to another site', () => {
    const c = certificateFor(HOST, 'wrong-name', today)
    expect(c.subject).toBe(`CN=${WRONG_CERT_NAME}`)
    expect(certProblem(c, HOST)?.curl).toBe(
      `curl: (60) SSL: no alternative certificate subject name matches target host name '${HOST}'`,
    )
  })

  it.each(['self-signed', 'expired', 'wrong-name'] as const)('curl https with a %s certificate stops after ServerHello', (state) => {
    const { captures, text } = run('patient', `curl -v https://${HOST}`, withCert(state))
    const tcp = tcpRecords(captures)
    // SYN, SYN-ACK, ACK, ClientHello, ServerHello, Alert, FIN, FIN — and no GET
    expect(tcp.map((c) => c.tcpFlags)).toEqual(['SYN', 'SYN, ACK', 'ACK', 'PSH, ACK', 'PSH, ACK', 'PSH, ACK', 'FIN, ACK', 'FIN, ACK'])
    const alert = tcp[5]!
    expect(alert.encrypted).toBe(true)
    expect(alert.srcPort).not.toBe(443) // the client sends the alert
    expect(captures.some((c) => c.payload?.startsWith('GET'))).toBe(false)
    expect(text).toContain('curl: (60)')
    expect(text).not.toContain('<!DOCTYPE html>')
  })

  it('-k carries on and says the check failed', () => {
    const { captures, text } = run('patient', `curl -vk https://${HOST}`, withCert('self-signed'))
    expect(text).toContain('*  SSL certificate verify result: self-signed certificate, continuing anyway.')
    expect(text).toContain('ⓘ -k skipped the certificate check')
    expect(text).toContain('CareConnect')
    expect(captures.filter((c) => c.payload?.startsWith('GET'))).toHaveLength(1)
  })

  it('-k with a valid certificate changes nothing', () => {
    const { text } = run('patient', `curl -v -k https://${HOST}`)
    expect(text).toContain('*  SSL certificate verify ok.')
    expect(text).not.toContain('continuing anyway')
  })

  it('a plain http request ignores the certificate', () => {
    const { text } = run('patient', `curl http://${HOST}`, withCert('expired'))
    expect(text).not.toContain('curl: (60)')
  })

  it('pop3 --tls refuses a bad certificate before the password is sent', () => {
    const net = withCert('expired')
    const { captures, text } = run('docpc', 'pop3 dr.nguyen@careconnect.example --tls', net)
    expect(text).toContain('pop3: TLS handshake failed: certificate has expired')
    expect(captures.some((c) => c.payload?.includes('Surgery2026!'))).toBe(false)
    // Nothing was downloaded, so the server still has the mail
    expect(net.nodes.find((n) => n.id === 'ccmail')!.data.mailboxes!.find((b) => b.address.startsWith('dr.nguyen'))!.messages).toHaveLength(2)
  })
})

describe('curl flags', () => {
  it('reads -v, -k, -I alone, combined and long', () => {
    expect(parseCurlFlags(['-vkI'])).toEqual({ verbose: true, insecure: true, head: true, unknown: [] })
    expect(parseCurlFlags(['--insecure', '--head'])).toEqual({ verbose: false, insecure: true, head: true, unknown: [] })
    expect(parseCurlFlags(['-L', '-v']).unknown).toEqual(['-L'])
  })
})

describe('HTTP → HTTPS redirect', () => {
  function redirecting() {
    const net = careConnect()
    net.nodes.find((n) => n.id === 'ccweb')!.data.redirectHttp = true
    return net
  }

  it('answers http with 301 and a Location header, readable on the wire', () => {
    const { captures, text } = run('patient', `curl -v http://${HOST}/book`, redirecting())
    const reply = tcpRecords(captures).find((c) => c.app === 'HTTP' && c.srcPort === 80)!
    expect(reply.encrypted).toBe(false)
    expect(reply.payload).toBe(`HTTP/1.1 301 Moved Permanently\nLocation: https://${HOST}/book\nContent-Length: 0`)
    expect(text).toContain('< HTTP/1.1 301 Moved Permanently')
    expect(text).toContain(`< Location: https://${HOST}/book`)
    expect(text).not.toContain('<!DOCTYPE html>')
    expect(text).toContain('ⓘ 301 Moved Permanently')
  })

  it('leaves https alone', () => {
    const { text } = run('patient', `curl https://${HOST}`, redirecting())
    expect(text).toContain('<!DOCTYPE html>')
    expect(text).not.toContain('301')
  })

  it('is off by default', () => {
    const { text } = run('patient', `curl http://${HOST}`)
    expect(text).toContain('<!DOCTYPE html>')
  })
})

describe('curl -I', () => {
  it('sends HEAD and prints only the headers', () => {
    const { captures, text } = run('patient', `curl -I http://${HOST}`)
    const req = tcpRecords(captures).find((c) => c.app === 'HTTP' && c.dstPort === 80)!
    expect(req.payload!.split('\n')[0]).toBe('HEAD / HTTP/1.1')
    const res = tcpRecords(captures).find((c) => c.app === 'HTTP' && c.srcPort === 80)!
    expect(res.payload).not.toContain('<!DOCTYPE html>')
    expect(res.payload).toMatch(/^HTTP\/1\.1 200 OK\nContent-Type: text\/html; charset=utf-8\nContent-Length: \d+$/)
    expect(text).toContain('HTTP/1.1 200 OK')
    expect(text).toContain('Content-Length:')
    expect(text).not.toContain('<!DOCTYPE html>')
  })

  it('shows the redirect target', () => {
    const net = careConnect()
    net.nodes.find((n) => n.id === 'ccweb')!.data.redirectHttp = true
    const { text } = run('patient', `curl -I http://${HOST}`, net)
    expect(text).toContain(`Location: https://${HOST}/`)
  })

  it('works over https, encrypted', () => {
    const { captures, text } = run('patient', `curl -I https://${HOST}`)
    expect(captures.find((c) => c.payload?.startsWith('HEAD'))!.encrypted).toBe(true)
    expect(text).toContain('HTTP/1.1 200 OK')
  })
})

describe('SMTP relay on port 25', () => {
  const SEND = 'smtp reception@careconnect.example referrals@gp-clinic.example "Referral"'

  it('passes mail for another domain from the server to the internet on port 25', () => {
    const { captures, text } = run('reception', SEND)
    expect(text).toContain('250 OK queued')
    expect(text).toContain("ⓘ Your server passes the message to the recipient's server on port 25.")
    const relay = captures.filter((c) => c.dstPort === 25 || c.srcPort === 25)
    expect(relay.length).toBeGreaterThan(0)
    // The mail server is the client now: it starts the connection from its own address
    const syn = relay.find((c) => c.tcpFlags === 'SYN')!
    expect(syn.srcIp).toBe('203.0.113.25')
    expect(syn.dstIp).toMatch(/^198\.51\.100\.\d+$/)
    expect(syn.srcPort).toBeGreaterThanOrEqual(49152)
    // No AUTH between servers, and the message is readable
    expect(relay.some((c) => c.payload?.startsWith('AUTH'))).toBe(false)
    expect(relay.find((c) => c.payload?.startsWith('From:'))!.encrypted).toBe(false)
    expect(relay.find((c) => c.payload?.startsWith('EHLO'))!.payload).toBe('EHLO mail.careconnect.example')
  })

  it('relays after a --tls submission too: TLS covers only your link to your server', () => {
    const { captures } = run('reception', `${SEND} --tls`)
    expect(captures.filter((c) => c.dstPort === 465).every((c) => c.encrypted || c.app === null || c.info.startsWith('Client Hello'))).toBe(true)
    expect(captures.find((c) => c.dstPort === 25 && c.payload?.startsWith('From:'))!.encrypted).toBe(false)
  })

  it('delivers into a second mail server in the network that holds the domain', () => {
    const net = careConnect()
    const ccmail = net.nodes.find((n) => n.id === 'ccmail')!
    net.nodes.push({
      ...structuredClone(ccmail), id: 'gpmail', position: { x: 0, y: 0 },
      data: { ...structuredClone(ccmail.data), label: 'GP Mail', ip: '198.51.100.7', mac: 'aa:bb:cc:09:00:07', mailDomain: 'gp-clinic.example',
        mailboxes: [{ address: 'referrals@gp-clinic.example', password: 'x', messages: [] }] },
    })
    net.edges.push({ id: 'gp-e1', source: 'net', target: 'gpmail' } as typeof net.edges[number])
    const { captures } = run('reception', SEND, net)
    expect(captures.find((c) => c.dstPort === 25 && c.tcpFlags === 'SYN')!.dstIp).toBe('198.51.100.7')
    const box = net.nodes.find((n) => n.id === 'gpmail')!.data.mailboxes![0]!
    expect(box.messages).toHaveLength(1)
    expect(box.messages[0]!.subject).toBe('Referral')
  })

  it('cannot route without an internet connection', () => {
    const net = careConnect()
    net.edges = net.edges.filter((e) => !(e.source === 'net' && e.target === 'ccrouter') && !(e.source === 'ccrouter' && e.target === 'net'))
    // the client's path to its own server must still exist: send from inside the server LAN instead
    const { text } = run('ccweb', SEND, net)
    expect(text).toContain('554 5.4.4')
  })
})

describe('DHCP capture records', () => {
  it('dhclient adds DISCOVER, OFFER, REQUEST, ACK over UDP 68 ⇄ 67', () => {
    const { captures } = run('patient', 'dhclient')
    const dhcp = captures.filter((c) => c.app === 'DHCP')
    expect(dhcp.map((c) => c.info.split(' - ')[0])).toEqual(['DHCP Discover', 'DHCP Offer', 'DHCP Request', 'DHCP ACK'])
    expect(dhcp.every((c) => c.transport === 'UDP' && !c.encrypted)).toBe(true)
    const [discover, offer] = dhcp
    expect(discover).toMatchObject({ srcIp: '0.0.0.0', srcPort: 68, dstIp: '255.255.255.255', dstPort: 67, dstMac: 'ff:ff:ff:ff:ff:ff' })
    expect(offer).toMatchObject({ srcIp: '192.168.1.1', srcPort: 67, dstPort: 68 })
    expect(offer!.payload).toContain('router (default gateway): 192.168.1.1')
    // One transaction ID for all four
    expect(new Set(dhcp.map((c) => c.info.split('Transaction ID ')[1])).size).toBe(1)
  })
})

describe('ssh capture records', () => {
  it('ssh to a server: TCP to 22, readable banners and key exchange, then encrypted', () => {
    const { captures, lines } = run('reception', 'ssh 203.0.113.21')
    const tcp = tcpRecords(captures)
    expect(tcp.every((c) => c.dstPort === 22 || c.srcPort === 22)).toBe(true)
    expect(tcp.slice(0, 3).map((c) => c.tcpFlags)).toEqual(['SYN', 'SYN, ACK', 'ACK'])
    const ssh = tcp.filter((c) => c.app === 'SSH')
    expect(ssh[0]!.payload).toBe('SSH-2.0-OpenSSH_9.6')
    const kexReply = ssh.findIndex((c) => c.info.includes('Key Exchange Reply'))
    expect(ssh.slice(0, kexReply + 1).every((c) => !c.encrypted)).toBe(true)
    expect(ssh.slice(kexReply + 1).length).toBeGreaterThan(0)
    expect(ssh.slice(kexReply + 1).every((c) => c.encrypted)).toBe(true)
    // Still enters the SSH session, once the last packet arrives
    expect(lines.some((l) => l.text === '\x1bSSH:ccfile')).toBe(true)
  })

  it('ssh to a server with SSH off: SYN, RST', () => {
    const net = careConnect()
    net.nodes.find((n) => n.id === 'ccfile')!.data.services = { ssh: false }
    const { captures, text } = run('reception', 'ssh 203.0.113.21', net)
    expect(tcpRecords(captures).map((c) => c.tcpFlags)).toEqual(['SYN', 'RST, ACK'])
    expect(text).toContain('ssh: connect to host 203.0.113.21 port 22: Connection refused')
  })
})

describe('tap a link', () => {
  const macOf = (net: ReturnType<typeof careConnect>, id: string) => net.nodes.find((n) => n.id === id)!.data.mac
  const edgeBetween = (net: ReturnType<typeof careConnect>, a: string, b: string) =>
    net.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))!

  it('keeps only packets that cross the tapped link; IPs stay, MACs are that link\'s', () => {
    const net = careConnect()
    const { captures } = run('patient', 'curl http://www.careconnect.example', net)
    const get = captures.find((c) => c.payload?.startsWith('GET'))!

    // Patient's Wi-Fi link: laptop → home gateway
    const wifi = tapView(get, edgeBetween(net, 'patient', 'homegw'), net.nodes)!
    expect(wifi).toMatchObject({ srcMac: macOf(net, 'patient'), dstMac: macOf(net, 'homegw'), srcIp: get.srcIp, dstIp: get.dstIp })

    // Server LAN, past the switch: the router addressed the frame to the web server
    const lan = tapView(get, edgeBetween(net, 'ccsw', 'ccweb'), net.nodes)!
    expect(lan).toMatchObject({ srcMac: macOf(net, 'ccrouter'), dstMac: macOf(net, 'ccweb'), srcIp: get.srcIp, dstIp: get.dstIp })

    // The reply crosses the same link the other way
    const reply = captures.find((c) => c.payload?.startsWith('HTTP/1.1 200'))!
    expect(tapView(reply, edgeBetween(net, 'ccsw', 'ccweb'), net.nodes)).toMatchObject({ srcMac: macOf(net, 'ccweb'), dstMac: macOf(net, 'ccrouter') })

    // The clinic's links never see the patient's traffic
    expect(tapView(get, edgeBetween(net, 'clinicgw', 'reception'), net.nodes)).toBeNull()
  })

  it('DNS crosses the DNS server\'s link, not the web server\'s', () => {
    const net = careConnect()
    const { captures } = run('patient', 'nslookup www.careconnect.example', net)
    const query = captures.find((c) => c.app === 'DNS')!
    expect(tapView(query, edgeBetween(net, 'ccsw', 'ccdns'), net.nodes)).not.toBeNull()
    expect(tapView(query, edgeBetween(net, 'ccsw', 'ccweb'), net.nodes)).toBeNull()
  })

  it('names the link for the drawer note', () => {
    const net = careConnect()
    expect(tapLabel(edgeBetween(net, 'patient', 'homegw'), net.nodes)).toBe("Patient's Laptop ⇄ Home Gateway (Wi-Fi)")
    expect(tapLabel(edgeBetween(net, 'ccsw', 'ccweb'), net.nodes)).toMatch(/\(wired\)$/)
  })
})
