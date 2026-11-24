import type { TerminalLine, PacketAnim, PendingCapture, AppProtocol, NetNode, CertificateState } from '../types'
import type { TermContext } from './context'
import { findPath, nodeById } from './network'
import { arpBefore, firstHopMacs, leg, populateMacTables, scaledHop } from './packets'
import { type Resolution, isResolveError, routeTo } from './resolve'

/**
 * The conversation engine (spec §2). A command builds a Conversation — client, server,
 * ports and an ordered list of Steps — and one player turns it into the packet animation,
 * the capture records and the timed terminal lines, so the three can never disagree.
 */

export type { AppProtocol } from '../types'

export type TcpFlags = 'SYN' | 'SYN, ACK' | 'ACK' | 'PSH, ACK' | 'FIN, ACK' | 'RST, ACK'

export interface Step {
  dir: 'c2s' | 's2c'
  transport: 'TCP' | 'UDP'
  tcpFlags?: TcpFlags
  app: AppProtocol           // null for pure TCP control segments (SYN etc.)
  label: string              // canvas label, ≤ 14 chars
  info: string               // capture Info column
  payload?: string           // exactly what is on the wire in cleartext (multi-line allowed)
  encrypted?: boolean        // capture shows ciphertext instead of payload
  cleartext?: string         // the readable part of a partly-encrypted record (TLS 1.3 ServerHello)
  note?: string              // an extra line for the capture detail pane
  serverPort?: number        // override (FTP data = 20)
  clientPort?: number        // override (FTP data connection's client port)
  lines?: TerminalLine[]     // printed when this Step's leg finishes
}

export interface Conversation {
  id: string
  clientId: string
  serverId: string           // node id (cloud node for internet hosts)
  serverIp: string
  serverPort: number
  clientPort: number
  steps: Step[]
}

/** Per-hop time for Conversations at Normal speed. */
export const CONV_HOP_MS = 300

// ── Ports and ids ────────────────────────────────────────────────────────────

/** IANA dynamic (ephemeral) port range. */
export const EPHEMERAL_MIN = 49152
export const EPHEMERAL_MAX = 65535

export function ephemeralPort(rand: () => number = Math.random): number {
  return EPHEMERAL_MIN + Math.floor(rand() * (EPHEMERAL_MAX - EPHEMERAL_MIN + 1))
}

let convSequence = 0

export function newConversation(
  clientId: string,
  serverId: string,
  serverIp: string,
  serverPort: number,
  steps: Step[],
  clientPort = ephemeralPort(),
): Conversation {
  return { id: `conv-${Date.now().toString(36)}-${++convSequence}`, clientId, serverId, serverIp, serverPort, clientPort, steps }
}

// ── Step builders (pure) ─────────────────────────────────────────────────────

export function tcpOpen(): Step[] {
  return [
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'SYN',      app: null, label: 'SYN',     info: '[SYN] Seq=0' },
    { dir: 's2c', transport: 'TCP', tcpFlags: 'SYN, ACK', app: null, label: 'SYN-ACK', info: '[SYN, ACK] Seq=0 Ack=1' },
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'ACK',      app: null, label: 'ACK',     info: '[ACK] Seq=1 Ack=1' },
  ]
}

/** The server opens the connection (FTP active-mode data connection). */
export function tcpOpenFromServer(): Step[] {
  return tcpOpen().map((s) => ({ ...s, dir: s.dir === 'c2s' ? 's2c' : 'c2s' }))
}

export function tcpRefused(): Step[] {
  return [
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'SYN',      app: null, label: 'SYN',     info: '[SYN] Seq=0' },
    { dir: 's2c', transport: 'TCP', tcpFlags: 'RST, ACK', app: null, label: 'RST',     info: '[RST, ACK] Seq=1 Ack=1 (port closed: connection refused)' },
  ]
}

/** Client closes first; `serverFirst` for a connection the server closes (FTP data). */
export function tcpClose(serverFirst = false): Step[] {
  const first: Step['dir'] = serverFirst ? 's2c' : 'c2s'
  const second: Step['dir'] = serverFirst ? 'c2s' : 's2c'
  return [
    { dir: first,  transport: 'TCP', tcpFlags: 'FIN, ACK', app: null, label: 'FIN', info: '[FIN, ACK]' },
    { dir: second, transport: 'TCP', tcpFlags: 'FIN, ACK', app: null, label: 'FIN', info: '[FIN, ACK]' },
  ]
}

/** A DNS query to port 53 (UDP) and its answer. `answerIp` null = NXDOMAIN. */
export function dnsLookup(name: string, answerIp: string | null): Step[] {
  return [
    { dir: 'c2s', transport: 'UDP', app: 'DNS', label: 'DNS query',
      info: `Standard query A ${name}`,
      payload: `Query: ${name}, type A, class IN` },
    answerIp
      ? { dir: 's2c', transport: 'UDP', app: 'DNS', label: 'DNS reply',
          info: `Standard query response A ${name} A ${answerIp}`,
          payload: `Answer: ${name}, type A, class IN, address ${answerIp}` }
      : { dir: 's2c', transport: 'UDP', app: 'DNS', label: 'NXDOMAIN',
          info: `Standard query response A ${name}, No such name`,
          payload: `Reply code: No such name (NXDOMAIN) for ${name}` },
  ]
}

export interface CertInfo {
  subject: string
  issuer: string
  start: Date
  expire: Date
  state: CertificateState
}

const DAY_MS = 86_400_000

/** The name a `wrong-name` certificate was issued for: a reserved example domain, so it is clearly someone else's. */
export const WRONG_CERT_NAME = 'www.example.org'

/**
 * A demo certificate, dated relative to today so it never goes stale.
 * - valid: issued to the host by Networx Demo CA, from today − 60 days to today + 300 days
 * - self-signed: issuer = subject (the server signed its own certificate)
 * - expired: from today − 425 days to today − 60 days
 * - wrong-name: valid, but issued to another site
 */
export function certificateFor(hostname: string, state: CertificateState = 'valid', today = new Date()): CertInfo {
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const endOfDay = (days: number) => new Date(midnight + days * DAY_MS + DAY_MS - 1000)
  const subject = `CN=${state === 'wrong-name' ? WRONG_CERT_NAME : hostname}`
  const expired = state === 'expired'
  return {
    subject,
    issuer: state === 'self-signed' ? subject : 'CN=Networx Demo CA',
    start: new Date(midnight - (expired ? 425 : 60) * DAY_MS),
    expire: endOfDay(expired ? -60 : 300),
    state,
  }
}

export interface CertProblem {
  /** curl's error line, e.g. `curl: (60) SSL certificate problem: self-signed certificate`. */
  curl: string
  /** The verification result in a few words, for `-k` and for the mail commands. */
  verify: string
  /** Chrome's error code, shown on the warning page. */
  browserCode: string
  /** Plain-language reason, for the warning page and an ⓘ line. */
  explain: string
}

/** What a client finds wrong with a certificate, or null when it checks out. */
export function certProblem(cert: CertInfo, host: string): CertProblem | null {
  switch (cert.state) {
    case 'self-signed':
      return {
        curl: 'curl: (60) SSL certificate problem: self-signed certificate',
        verify: 'self-signed certificate',
        browserCode: 'NET::ERR_CERT_AUTHORITY_INVALID',
        explain: `The certificate was signed by the server itself (issuer = subject = ${cert.subject}), so no trusted certificate authority vouches for it.`,
      }
    case 'expired':
      return {
        curl: 'curl: (60) SSL certificate problem: certificate has expired',
        verify: 'certificate has expired',
        browserCode: 'NET::ERR_CERT_DATE_INVALID',
        explain: `The certificate expired on ${formatCertDate(cert.expire)}. An expired certificate is no longer trusted.`,
      }
    case 'wrong-name':
      return {
        curl: `curl: (60) SSL: no alternative certificate subject name matches target host name '${host}'`,
        verify: `certificate subject name does not match target host name '${host}'`,
        browserCode: 'NET::ERR_CERT_COMMON_NAME_INVALID',
        explain: `The certificate was issued to ${cert.subject.replace(/^CN=/, '')}, not ${host}. It could belong to a different server.`,
      }
    default:
      return null
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** curl's date format: `Sep 24 00:00:00 2026 GMT`. */
export function formatCertDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`
}

/** TLS 1.3 handshake (one round trip). The ClientHello, including the site name, is readable. */
export function tlsHandshake(serverName: string, cert: CertInfo): Step[] {
  return [
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: 'ClientHello',
      info: `Client Hello (SNI=${serverName})`,
      payload: `TLS ClientHello\n  version: TLS 1.3\n  server_name: ${serverName}\n  (+ a random number and the client's key share)` },
    { dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: 'ServerHello',
      info: 'Server Hello, Change Cipher Spec, Application Data',
      cleartext: "TLS ServerHello (+ the server's key share)",
      payload: `EncryptedExtensions\nCertificate: subject ${cert.subject}, issuer ${cert.issuer}\nCertificateVerify\nFinished`,
      encrypted: true,
      note: "The certificate and the server's Finished message are inside the encrypted part (TLS 1.3)." },
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: '🔒 Finished',
      info: 'Change Cipher Spec, Application Data',
      payload: 'Finished (client handshake complete)',
      encrypted: true },
  ]
}

/**
 * The client rejects the certificate: ClientHello, ServerHello (the certificate is in its encrypted part),
 * then the client's alert. In TLS 1.3 the alert is encrypted too, so a capture shows only Application Data.
 */
export function tlsRejected(serverName: string, cert: CertInfo, reason: string): Step[] {
  const [hello, serverHello] = tlsHandshake(serverName, cert)
  return [
    hello!,
    serverHello!,
    { dir: 'c2s', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'TLS', label: '🔒 Alert',
      info: 'Application Data',
      payload: `Alert (fatal): certificate rejected — ${reason}`,
      encrypted: true },
  ]
}

/** Carry application steps inside TLS: same payloads, but only ciphertext on the wire. */
export function insideTls(steps: Step[]): Step[] {
  return steps.map((s) => ({
    ...s,
    app: 'TLS',
    encrypted: true,
    label: s.label.startsWith('🔒') ? s.label : `🔒 ${s.label}`.slice(0, 14),
    info: 'Application Data',
    note: undefined,  // nothing about the content may leak into the capture
  }))
}

// ── Ciphertext picture (not real cryptography) ───────────────────────────────

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Size of the encrypted application data: payload length + 22. */
export function cipherLength(payload: string): number {
  return byteLength(payload) + 22
}

/** Deterministic pseudo-random bytes from conversation id + step index, as hex: the first 24 bytes then … */
export function cipherHex(conversationId: string, stepIndex: number, tlsRecord = true, previewBytes = 24): string {
  let x = hash32(`${conversationId}#${stepIndex}`) || 1
  const bytes: string[] = []
  for (let i = 0; i < previewBytes; i++) {
    // xorshift32
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    bytes.push((x & 0xff).toString(16).padStart(2, '0'))
  }
  // A TLS application-data record really does start 17 03 03 (type 23, legacy version 3.3)
  if (tlsRecord) bytes.splice(0, 3, '17', '03', '03')
  return `${bytes.join(' ')} …`
}

/** A stable SSH host-key fingerprint for a node: 43 base64 characters, the same every run. */
export function hostKeyFingerprint(nodeId: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let x = hash32(`hostkey:${nodeId}`) || 1
  let out = ''
  for (let i = 0; i < 43; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    out += alphabet[x & 63]
  }
  return out
}

// ── Player ───────────────────────────────────────────────────────────────────

const ANIM_PROTOCOL: Record<string, PacketAnim['protocol']> = {
  DNS: 'DNS', HTTP: 'HTTP', TLS: 'TLS', FTP: 'FTP', 'FTP-DATA': 'FTP', SSH: 'SSH',
  SMTP: 'SMTP', POP3: 'POP3', IMAP: 'IMAP',
}

function animProtocol(step: Step): PacketAnim['protocol'] {
  return (step.app && ANIM_PROTOCOL[step.app]) || step.transport
}

export interface PlayResult {
  packets: PacketAnim[]
  captures: PendingCapture[]
  lines: TerminalLine[]
  endMs: number
}

/**
 * Turn a Conversation into packets, capture records and timed lines.
 * Each Step is one leg along `path` (forward for c2s, back for s2c) and starts when the
 * previous one ends; its capture record is due when the leg starts and its lines when it ends.
 */
export function playConversation(
  conv: Conversation,
  path: string[],
  ctx: TermContext,
  startMs = 0,
): PlayResult {
  const client = nodeById(conv.clientId, ctx.nodes)
  const server = nodeById(conv.serverId, ctx.nodes)
  const hop = scaledHop(CONV_HOP_MS)
  const legMs = (path.length - 1) * hop

  populateMacTables(path, ctx)
  const arp = client && server ? arpBefore(client, server, ctx, startMs) : { packets: [], captures: [], endMs: startMs }

  const packets: PacketAnim[] = [...arp.packets]
  const captures: PendingCapture[] = [...arp.captures]
  const lines: TerminalLine[] = []
  const c2sMacs = firstHopMacs(path, ctx.nodes)
  const reversed = [...path].reverse()
  const s2cMacs = firstHopMacs(reversed, ctx.nodes)
  const clientIp = client?.data.ip ?? ''

  let t = arp.endMs
  conv.steps.forEach((step, i) => {
    const back = step.dir === 's2c'
    packets.push(...leg(path, ctx.edges, animProtocol(step), step.label, t, back, hop))
    captures.push({ ...captureFor(conv, step, i, t, clientIp, back ? s2cMacs : c2sMacs), route: back ? reversed : path })
    const end = t + legMs
    for (const line of step.lines ?? []) lines.push({ ...line, delayMs: end + (line.delayMs ?? 0) })
    t = end
  })

  return { packets, captures, lines, endMs: t }
}

function captureFor(
  conv: Conversation,
  step: Step,
  stepIndex: number,
  delayMs: number,
  clientIp: string,
  macs: { srcMac: string; dstMac: string },
): PendingCapture {
  const serverPort = step.serverPort ?? conv.serverPort
  const clientPort = step.clientPort ?? conv.clientPort
  const c2s = step.dir === 'c2s'
  const plainBytes = (step.cleartext ? byteLength(step.cleartext) : 0) + (step.payload ? byteLength(step.payload) : 0)
  const appBytes = step.encrypted
    ? (step.cleartext ? byteLength(step.cleartext) : 0) + cipherLength(step.payload ?? '')
    : plainBytes
  return {
    delayMs,
    conversationId: conv.id,
    stepIndex,
    srcIp: c2s ? clientIp : conv.serverIp,
    srcPort: c2s ? clientPort : serverPort,
    dstIp: c2s ? conv.serverIp : clientIp,
    dstPort: c2s ? serverPort : clientPort,
    srcMac: macs.srcMac,
    dstMac: macs.dstMac,
    transport: step.transport,
    tcpFlags: step.tcpFlags,
    app: step.app,
    info: `${step.encrypted ? '🔒 ' : ''}${step.info}`,
    payload: step.payload,
    cleartext: step.cleartext,
    note: step.note,
    encrypted: !!step.encrypted,
    length: appBytes + 20 + (step.transport === 'TCP' ? 20 : 8),
  }
}

// ── Running Conversations from a command ─────────────────────────────────────

export interface Leg { conv: Conversation; path: string[] }

/**
 * Play Conversations one after another: dispatch their packets and capture records,
 * remember TCP connections for netstat, and return the timed lines.
 */
export function runConversations(
  list: Leg[],
  ctx: TermContext,
  startMs = 0,
): { lines: TerminalLine[]; endMs: number } {
  let t = startMs
  const lines: TerminalLine[] = []
  for (const { conv, path } of list) {
    const r = playConversation(conv, path, ctx, t)
    ctx.dispatchPackets?.(r.packets)
    ctx.dispatchCaptures?.(r.captures)
    lines.push(...r.lines)
    if (conv.steps[0]?.transport === 'TCP') {
      const client = nodeById(conv.clientId, ctx.nodes)
      ctx.recordConnection?.(conv.clientId, {
        localIp: client?.data.ip ?? '',
        localPort: conv.clientPort,
        remoteIp: conv.serverIp,
        remotePort: conv.serverPort,
      })
    }
    t = r.endMs
  }
  return { lines, endMs: t }
}

/** The DNS Conversation for a resolution — played whenever a DNS server was asked, even for NXDOMAIN. */
export function dnsConversation(r: Resolution, ctx: TermContext, lines?: TerminalLine[]): Leg | null {
  if (!r.dnsServerNode || !r.dnsServerIp) return null
  const route = routeTo(r.dnsServerNode, r.dnsServerIp, ctx)
  if (!route.ok) return null
  const path = route.path
  const steps = dnsLookup(r.name, isResolveError(r) ? null : r.ip)
  if (lines) steps[1]!.lines = lines
  return { conv: newConversation(ctx.selfId, r.dnsServerNode.id, r.dnsServerIp, 53, steps), path }
}

/** Path from this device to `server`, or null. */
export function pathTo(server: NetNode, ctx: TermContext): string[] | null {
  return findPath(ctx.selfId, server.id, ctx.nodes, ctx.edges)
}
