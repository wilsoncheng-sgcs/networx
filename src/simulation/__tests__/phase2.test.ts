import { describe, it, expect } from 'vitest'
import type { CertificateState } from '../../types'
import { certificateFor, certProblem, formatCertDate, WRONG_CERT_NAME } from '../exchange'
import { parseCurlFlags } from '../protocols/web'
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
