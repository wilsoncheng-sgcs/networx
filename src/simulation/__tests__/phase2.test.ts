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
