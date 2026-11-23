import type { Mailbox, MailMessage, NetNode, NodeData } from '../../types'
import { type TermContext, type Lines, out, err, info, self } from '../context'
import { type Step, tcpOpen, tcpClose, tlsHandshake, tlsRejected, insideTls, certificateFor, certProblem, byteLength } from '../exchange'
import { connectTo, isFailure, serviceUp, refuse, play, portOf, c2s, s2c, type Target } from './common'
import type { ServiceId } from '../services'

// ── Messages and mailboxes ───────────────────────────────────────────────────

export function formatMessage(m: MailMessage): string {
  return `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.body}`
}

export function messageSize(m: MailMessage): number {
  return byteLength(formatMessage(m))
}

export function domainOf(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? ''
}

/** The mail server finds a mailbox by full address, case-insensitive. */
export function findMailbox(server: NetNode, address: string): Mailbox | undefined {
  return (server.data.mailboxes ?? []).find((b) => b.address.toLowerCase() === address.toLowerCase())
}

function isAddress(s: string | undefined): s is string {
  return !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
}

/** Run a state change when the session finishes (immediately when there is no scheduler, as in tests). */
function later(ctx: TermContext, ms: number, fn: () => void): void {
  if (ctx.schedule) ctx.schedule(ms, fn)
  else fn()
}

function patchMailbox(server: NetNode, address: string, change: (b: Mailbox) => Mailbox): Partial<NodeData> {
  return {
    mailboxes: (server.data.mailboxes ?? []).map((b) =>
      b.address.toLowerCase() === address.toLowerCase() ? change(b) : b,
    ),
  }
}

/** Find the client's mail server: `mail.<domain of address>` via DNS (no MX records in Networx). */
function mailServer(cmd: string, address: string, ctx: TermContext): Target | { lines: Lines } {
  const host = `mail.${domainOf(address)}`
  return connectTo(host, ctx, {
    unresolved: [err(`${cmd}: ${host}: Name or service not known`)],
    noRoute: [err(`${cmd}: connect to ${host}: No route to host`)],
  })
}

/** With --tls: a TLS handshake straight after the TCP handshake, then the whole session inside TLS. */
function withTls(t: Target, steps: Step[], tls: boolean): Step[] {
  if (!tls) return steps
  return [...tlsHandshake(t.r.name, certificateFor(t.r.name, t.server.data.certificate ?? 'valid')), ...insideTls(steps)]
}

/**
 * With --tls and a certificate that fails the check: the client hangs up after ServerHello, before
 * sending its password. Returns the timed lines, or null when the certificate is fine (or no TLS).
 */
function tlsRefusal(cmd: string, t: Target, tls: boolean, port: number, ctx: TermContext): Lines | null {
  if (!tls) return null
  const cert = certificateFor(t.r.name, t.server.data.certificate ?? 'valid')
  const problem = certProblem(cert, t.r.name)
  if (!problem) return null
  const rejected = tlsRejected(t.r.name, cert, problem.verify)
  rejected[1]!.lines = [
    err(`${cmd}: TLS handshake failed: ${problem.verify}`),
    info(`ⓘ ${problem.explain} The client stopped before sending the password.`),
  ]
  return play(t, port, [...tcpOpen(), ...rejected, ...tcpClose()], ctx)
}

// ── POP3 ─────────────────────────────────────────────────────────────────────

export interface Pop3Options {
  address: string
  password: string
  mailbox: Mailbox | undefined
  keep: boolean
}

/** A POP3 session: log in, STAT, RETR every message, DELE them (unless keep), QUIT. */
export function pop3Session(o: Pop3Options): Step[] {
  const P = (dir: 'c2s' | 's2c', label: string, payload: string, lines?: Lines) =>
    (dir === 'c2s' ? c2s : s2c)('POP3', label, payload, undefined, lines ? { lines } : {})

  const steps: Step[] = [
    P('s2c', '+OK', '+OK POP3 server ready', [out('+OK POP3 server ready')]),
    P('c2s', 'USER', `USER ${o.address}`),
  ]
  if (!o.mailbox) {
    steps.push(
      P('s2c', '-ERR', '-ERR no such mailbox', [err('-ERR no such mailbox')]),
      P('c2s', 'QUIT', 'QUIT'),
      P('s2c', '+OK bye', '+OK bye'),
    )
    return steps
  }

  const msgs = o.mailbox.messages
  const n = msgs.length
  const total = msgs.reduce((sum, m) => sum + messageSize(m), 0)
  steps.push(
    P('s2c', '+OK', '+OK'),
    P('c2s', 'PASS', `PASS ${o.password}`),
    P('s2c', '+OK', '+OK logged in', [out(`Logged in as ${o.address}`)]),
    P('c2s', 'STAT', 'STAT'),
    P('s2c', `+OK ${n}`, `+OK ${n} ${total}`, [
      out(n ? `${n} message${n === 1 ? '' : 's'} (${total.toLocaleString('en-US')} bytes)` : '0 messages on the server. Nothing to download.'),
    ]),
  )

  if (n > 0) {
    const retr = (m: MailMessage) => `+OK ${messageSize(m)} octets\n${formatMessage(m)}\n.`
    const downloaded = out(`Downloaded ${n} message${n === 1 ? '' : 's'} to this device.`)
    if (n <= 2) {
      msgs.forEach((m, i) => {
        steps.push(
          P('c2s', `RETR ${i + 1}`, `RETR ${i + 1}`),
          P('s2c', '+OK msg', retr(m), i === n - 1 ? [downloaded] : undefined),
        )
      })
    } else {
      // Keep the leg count sane: all RETRs in one leg, all replies in one leg
      steps.push(
        P('c2s', `RETR 1–${n}`, msgs.map((_, i) => `RETR ${i + 1}`).join('\n')),
        P('s2c', `+OK ${n} msgs`, msgs.map(retr).join('\n'), [downloaded]),
      )
    }

    if (!o.keep) {
      const deleted = out(`Deleted ${n} message${n === 1 ? '' : 's'} from the server.`)
      if (n <= 2) {
        msgs.forEach((_, i) => {
          steps.push(
            P('c2s', `DELE ${i + 1}`, `DELE ${i + 1}`),
            P('s2c', '+OK', `+OK message ${i + 1} deleted`, i === n - 1 ? [deleted] : undefined),
          )
        })
      } else {
        steps.push(
          P('c2s', `DELE 1–${n}`, msgs.map((_, i) => `DELE ${i + 1}`).join('\n')),
          P('s2c', '+OK', msgs.map((_, i) => `+OK message ${i + 1} deleted`).join('\n'), [deleted]),
        )
      }
    }
  }

  steps.push(
    P('c2s', 'QUIT', 'QUIT'),
    P('s2c', '+OK bye', '+OK bye', n === 0 ? [] : [
      o.keep
        ? info(`ⓘ --keep: the ${n === 1 ? 'message stays' : 'messages stay'} on the server. Without it, POP3 deletes what it downloads.`)
        : info('ⓘ POP3 downloads mail to ONE device. Run `pop3` on another device now: the server has nothing left to give it.'),
      out('Type `mail` to read the messages on this device.'),
    ]),
  )
  return steps
}

export function cmdPop3(args: string[], ctx: TermContext): Lines {
  const address = args.find((a) => !a.startsWith('--'))
  const keep = args.includes('--keep')
  const tls = args.includes('--tls')
  if (!isAddress(address)) return [err('Usage: pop3 <address> [--keep] [--tls]   e.g. pop3 dr.nguyen@careconnect.example')]

  const t = mailServer('pop3', address, ctx)
  if (isFailure(t)) return t.lines
  const service: ServiceId = tls ? 'pop3s' : 'pop3'
  const port = portOf(service)
  const intro = tls
    ? info(`ⓘ POP3 over TLS on port ${port} (TCP). After the TLS handshake, the password and the mail are encrypted.`)
    : info(`ⓘ POP3 on port ${port} (TCP). Username and password are sent in plain text.`)
  if (!serviceUp(t, service)) {
    return [intro, ...refuse(t, port, ctx, [err(`pop3: connect to ${t.r.name} (${t.r.ip}) port ${port}: Connection refused`)])]
  }

  const refusal = tlsRefusal('pop3', t, tls, port, ctx)
  if (refusal) return [intro, ...refusal]

  const mailbox = findMailbox(t.server, address)
  const steps = [...tcpOpen(), ...withTls(t, pop3Session({ address, password: mailbox?.password ?? '', mailbox, keep }), tls)]
  const lines = play(t, port, steps, ctx)

  if (mailbox && mailbox.messages.length) {
    const client = self(ctx)
    const server = t.server
    const endMs = Math.max(0, ...lines.map((l) => l.delayMs ?? 0))
    later(ctx, endMs, () => {
      const stamp = Date.now().toString(36)
      ctx.updateNodeData?.(client.id, {
        localMail: [...(client.data.localMail ?? []), ...mailbox.messages.map((m, i) => ({ ...m, id: `pop-${stamp}-${i}` }))],
      })
      // POP3 deletes on QUIT
      if (!keep) ctx.updateNodeData?.(server.id, patchMailbox(server, address, (b) => ({ ...b, messages: [] })))
    })
  }
  return [intro, ...lines]
}

// ── IMAP ─────────────────────────────────────────────────────────────────────

export interface ImapOptions {
  address: string
  password: string
  mailbox: Mailbox | undefined
  read?: number            // 1-based message number to read
}

function imapAddress(address: string): string {
  const [user, host] = address.split('@')
  return `((NIL NIL "${user}" "${host}"))`
}

function envelope(m: MailMessage): string {
  const from = imapAddress(m.from)
  return `ENVELOPE (NIL "${m.subject}" ${from} ${from} ${from} ${imapAddress(m.to)} NIL NIL NIL NIL)`
}

/** Pad to a display width (emoji-free text only). */
function pad(s: string, w: number): string {
  return s.length >= w ? `${s.slice(0, w - 1)}…` : s.padEnd(w)
}

function messageTable(msgs: MailMessage[], seen: (i: number) => boolean): Lines {
  return [
    out(`  #  Seen  ${pad('From', 34)}Subject`),
    ...msgs.map((m, i) => out(`${String(i + 1).padStart(3)}  ${seen(i) ? '✓' : '–'}     ${pad(m.from, 34)}${m.subject}`)),
  ]
}

/** An IMAP session: log in, SELECT INBOX, list envelopes, optionally read one (marking it \Seen), LOGOUT. */
export function imapSession(o: ImapOptions): Step[] {
  const I = (dir: 'c2s' | 's2c', label: string, payload: string, lines?: Lines) =>
    (dir === 'c2s' ? c2s : s2c)('IMAP', label, payload, undefined, lines ? { lines } : {})

  const steps: Step[] = [
    I('s2c', '* OK', '* OK IMAP4rev1 ready'),
    I('c2s', 'a1 LOGIN', `a1 LOGIN ${o.address} ${o.password}`),
  ]
  if (!o.mailbox) {
    steps.push(
      I('s2c', 'a1 NO', 'a1 NO [AUTHENTICATIONFAILED] Invalid credentials', [err('a1 NO [AUTHENTICATIONFAILED] Invalid credentials')]),
      I('c2s', 'a6 LOGOUT', 'a6 LOGOUT'),
      I('s2c', '* BYE', '* BYE logging out\na6 OK LOGOUT completed'),
    )
    return steps
  }

  const msgs = o.mailbox.messages
  const n = msgs.length
  const k = o.read
  const validRead = k !== undefined && k >= 1 && k <= n
  steps.push(
    I('s2c', 'a1 OK', 'a1 OK LOGIN completed', [out(`Logged in as ${o.address}`)]),
    I('c2s', 'a2 SELECT', 'a2 SELECT INBOX'),
    I('s2c', `* ${n} EXISTS`, `* ${n} EXISTS\na2 OK [READ-WRITE] SELECT completed`, [out(`INBOX: ${n} message${n === 1 ? '' : 's'}`)]),
  )
  if (n > 0) {
    steps.push(
      I('c2s', 'a3 FETCH', `a3 FETCH 1:${n} (FLAGS ENVELOPE)`),
      I('s2c', 'envelopes',
        [...msgs.map((m, i) => `* ${i + 1} FETCH (FLAGS (${m.seen ? '\\Seen' : ''}) ${envelope(m)})`), 'a3 OK FETCH completed'].join('\n'),
        messageTable(msgs, (i) => msgs[i]!.seen)),
    )
  }
  if (k !== undefined) {
    if (validRead) {
      const m = msgs[k - 1]!
      steps.push(
        I('c2s', 'a4 FETCH', `a4 FETCH ${k} BODY[]`),
        I('s2c', 'message', `* ${k} FETCH (BODY[] {${messageSize(m)}}\n${formatMessage(m)}\n)\na4 OK FETCH completed`,
          [out(''), ...formatMessage(m).split('\n').map((l) => out(l)), out('')]),
        I('c2s', 'a5 STORE', `a5 STORE ${k} +FLAGS (\\Seen)`),
        I('s2c', 'a5 OK', `* ${k} FETCH (FLAGS (\\Seen))\na5 OK STORE completed`),
      )
    } else {
      steps.push(
        I('c2s', 'a4 FETCH', `a4 FETCH ${k} BODY[]`),
        I('s2c', 'a4 BAD', 'a4 BAD Invalid message number', [err(`a4 BAD Invalid message number (there ${n === 1 ? 'is' : 'are'} ${n})`)]),
      )
    }
  }
  steps.push(
    I('c2s', 'a6 LOGOUT', 'a6 LOGOUT'),
    I('s2c', '* BYE', '* BYE logging out\na6 OK LOGOUT completed', [
      info(`ⓘ IMAP leaves mail on the server. Check from another device: you'll see the same messages${validRead ? ', and this one marked as read' : ''}.`),
    ]),
  )
  return steps
}

export function cmdImap(args: string[], ctx: TermContext): Lines {
  const tls = args.includes('--tls')
  const rest = args.filter((a) => !a.startsWith('--'))
  const address = rest[0]
  const readIdx = rest.indexOf('read')
  const read = readIdx > 0 ? Number(rest[readIdx + 1]) : undefined
  if (!isAddress(address) || (readIdx > 0 && !Number.isInteger(read))) {
    return [err('Usage: imap <address> [read <n>] [--tls]   e.g. imap dr.nguyen@careconnect.example read 1')]
  }

  const t = mailServer('imap', address, ctx)
  if (isFailure(t)) return t.lines
  const service: ServiceId = tls ? 'imaps' : 'imap'
  const port = portOf(service)
  const intro = tls
    ? info(`ⓘ IMAP over TLS on port ${port} (TCP). After the TLS handshake, the password and the mail are encrypted.`)
    : info(`ⓘ IMAP on port ${port} (TCP). Username and password are sent in plain text.`)
  if (!serviceUp(t, service)) {
    return [intro, ...refuse(t, port, ctx, [err(`imap: connect to ${t.r.name} (${t.r.ip}) port ${port}: Connection refused`)])]
  }

  const refusal = tlsRefusal('imap', t, tls, port, ctx)
  if (refusal) return [intro, ...refusal]

  const mailbox = findMailbox(t.server, address)
  const steps = [...tcpOpen(), ...withTls(t, imapSession({ address, password: mailbox?.password ?? '', mailbox, read }), tls)]
  const lines = play(t, port, steps, ctx)

  if (mailbox && read !== undefined && read >= 1 && read <= mailbox.messages.length) {
    const server = t.server
    const endMs = Math.max(0, ...lines.map((l) => l.delayMs ?? 0))
    // Marked as read on the server's copy, so every device sees it
    later(ctx, endMs, () => ctx.updateNodeData?.(server.id, patchMailbox(server, address, (b) => ({
      ...b,
      messages: b.messages.map((m, i) => (i === read - 1 ? { ...m, seen: true } : m)),
    }))))
  }
  return [intro, ...lines]
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

export const SMTP_BODY = 'This message was sent from Networx.'

/** AUTH PLAIN credentials: Base64 of NUL user NUL password. An encoding, not encryption. */
export function authPlain(user: string, password: string): string {
  return btoa(`\u0000${user}\u0000${password}`)
}

export interface SmtpOptions {
  serverHost: string        // e.g. mail.careconnect.example
  clientName: string        // EHLO name
  from: string
  to: string
  subject: string
  password: string | null   // null: the sender has no mailbox here
  mailDomain: string
  recipientExists: boolean
}

export type SmtpOutcome = 'queued' | 'auth-failed' | 'relay-denied' | 'unknown-user'

export function smtpOutcome(o: SmtpOptions): SmtpOutcome {
  if (o.password === null) return 'auth-failed'
  if (domainOf(o.to) !== o.mailDomain.toLowerCase()) return 'relay-denied'
  if (!o.recipientExists) return 'unknown-user'
  return 'queued'
}

/** Submitting a message: EHLO, AUTH PLAIN, MAIL FROM / RCPT TO / DATA, the message, QUIT. */
export function smtpSend(o: SmtpOptions): Step[] {
  const S = (dir: 'c2s' | 's2c', label: string, payload: string, extra: Partial<Step> = {}) =>
    (dir === 'c2s' ? c2s : s2c)('SMTP', label, payload, undefined, extra)
  const outcome = smtpOutcome(o)
  const password = o.password ?? ''
  const quit = [
    S('c2s', 'QUIT', 'QUIT'),
    S('s2c', '221 Bye', '221 Bye', { lines: [out('221 Bye')] }),
  ]

  const steps: Step[] = [
    S('s2c', '220', `220 ${o.serverHost} ESMTP`, { lines: [out(`220 ${o.serverHost} ESMTP`)] }),
    S('c2s', 'EHLO', `EHLO ${o.clientName}`),
    S('s2c', '250', `250-${o.serverHost} Hello ${o.clientName}\n250 AUTH PLAIN`),
    S('c2s', 'AUTH PLAIN', `AUTH PLAIN ${authPlain(o.from, password)}`, {
      note: `Base64 decodes to: \\0${o.from}\\0${password}`,
      lines: [info('ⓘ The password was sent as Base64 — an encoding, not encryption. Anyone capturing this packet can decode it.')],
    }),
  ]

  if (outcome === 'auth-failed') {
    steps.push(S('s2c', '535', '535 5.7.8 Authentication credentials invalid', { lines: [err('535 5.7.8 Authentication credentials invalid')] }), ...quit)
    return steps
  }

  steps.push(
    S('s2c', '235', '235 2.7.0 Authentication successful', { lines: [out('235 2.7.0 Authentication successful')] }),
    S('c2s', 'MAIL FROM', `MAIL FROM:<${o.from}>\nRCPT TO:<${o.to}>\nDATA`, { info: `Request: MAIL FROM:<${o.from}> | RCPT TO:<${o.to}> | DATA` }),
  )

  if (outcome === 'relay-denied' || outcome === 'unknown-user') {
    const reason = outcome === 'relay-denied'
      ? '550 relay not permitted in Networx'
      : `550 5.1.1 <${o.to}>: Recipient address rejected: User unknown`
    steps.push(S('s2c', '550', `250 OK\n${reason}\n554 5.5.1 Error: no valid recipients`, { lines: [err(reason)] }), ...quit)
    return steps
  }

  steps.push(
    S('s2c', '354', '250 OK\n250 OK\n354 End data with <CR><LF>.<CR><LF>'),
    S('c2s', 'message', `From: ${o.from}\nTo: ${o.to}\nSubject: ${o.subject}\n\n${SMTP_BODY}\n.`, { info: `Message: Subject: ${o.subject}` }),
    S('s2c', '250 queued', '250 OK queued', { lines: [out('250 OK queued')] }),
    ...quit,
  )
  return steps
}

function ehloName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client'
}

export function cmdSmtp(args: string[], ctx: TermContext): Lines {
  const tls = args.includes('--tls')
  const [from, to, subject] = args.filter((a) => a !== '--tls')
  if (!isAddress(from) || !isAddress(to) || !subject) {
    return [err('Usage: smtp <from> <to> "<subject>" [--tls]'), err('  e.g. smtp reception@careconnect.example dr.nguyen@careconnect.example "Patient arrived"')]
  }

  const t = mailServer('smtp', from, ctx)
  if (isFailure(t)) return t.lines
  const service: ServiceId = tls ? 'smtps' : 'submission'
  const port = portOf(service)
  const intro = tls
    ? info(`ⓘ SMTP over TLS on port ${port} (TCP): sending, encrypted from the start.`)
    : info(`ⓘ SMTP submission on port ${port} (TCP): your device sends mail to its own mail server.`)
  if (!serviceUp(t, service)) {
    return [intro, ...refuse(t, port, ctx, [err(`smtp: connect to ${t.r.name} (${t.r.ip}) port ${port}: Connection refused`)])]
  }

  const refusal = tlsRefusal('smtp', t, tls, port, ctx)
  if (refusal) return [intro, ...refusal]

  const sender = findMailbox(t.server, from)
  const recipient = findMailbox(t.server, to)
  const opts: SmtpOptions = {
    serverHost: t.r.name,
    clientName: ehloName(self(ctx).data.label),
    from, to, subject,
    password: sender?.password ?? null,
    mailDomain: t.server.data.mailDomain ?? '',
    recipientExists: !!recipient,
  }
  let session = smtpSend(opts)
  if (tls) {
    // Inside TLS a capture can't read AUTH, so there is nothing to decode — and no Base64 warning
    session = session.map((s) => (s.note ? { ...s, note: undefined, lines: [info('ⓘ AUTH travelled inside TLS this time: a capture shows only ciphertext.')] } : s))
  }
  const steps = [...tcpOpen(), ...withTls(t, session, tls)]
  const lines = play(t, port, steps, ctx)

  if (smtpOutcome(opts) === 'queued') {
    const server = t.server
    const endMs = Math.max(0, ...lines.map((l) => l.delayMs ?? 0))
    later(ctx, endMs, () => ctx.updateNodeData?.(server.id, patchMailbox(server, to, (b) => ({
      ...b,
      messages: [...b.messages, { id: `m-${Date.now().toString(36)}`, from, to, subject, body: SMTP_BODY, seen: false }],
    }))))
  }
  return [intro, ...lines]
}

// ── mail (local) ─────────────────────────────────────────────────────────────

export function cmdMail(args: string[], ctx: TermContext): Lines {
  const msgs = self(ctx).data.localMail ?? []
  if (args[0]) {
    const n = Number(args[0])
    const m = Number.isInteger(n) ? msgs[n - 1] : undefined
    if (!m) return [err(`mail: no message ${args[0]} (${msgs.length} on this device)`)]
    return formatMessage(m).split('\n').map((l) => out(l))
  }
  if (msgs.length === 0) {
    return [out('No mail on this device.'), info('ⓘ Mail read with IMAP stays on the server. Use pop3 to download mail to this device.')]
  }
  return [
    out(`${msgs.length} message${msgs.length === 1 ? '' : 's'} on this device (downloaded by POP3):`),
    out(`  #  ${pad('From', 34)}Subject`),
    ...msgs.map((m, i) => out(`${String(i + 1).padStart(3)}  ${pad(m.from, 34)}${m.subject}`)),
    out(''),
    out('Type `mail <n>` to read one.'),
  ]
}
