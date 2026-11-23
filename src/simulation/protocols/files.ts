import type { StoredFile } from '../../types'
import { type TermContext, type Lines, out, err, info } from '../context'
import { FTP_DATA_PORT } from '../services'
import { DEFAULT_ACCOUNT } from '../defaults'
import { type Step, tcpOpen, tcpOpenFromServer, tcpClose, ephemeralPort, byteLength, hostKeyFingerprint } from '../exchange'
import { connectTo, isFailure, serviceUp, refuse, play, portOf, c2s, s2c } from './common'

export type FileAction = { cmd: 'ls' } | { cmd: 'get'; file: string }

/** `ls` (default) or `get <file>` from the arguments after the host. */
export function parseFileAction(args: string[]): FileAction | null {
  const [verb, file] = args
  if (!verb || verb === 'ls' || verb === 'dir') return { cmd: 'ls' }
  if (verb === 'get' && file) return { cmd: 'get', file }
  return null
}

function listing(files: StoredFile[], user: string): string {
  return files
    .map((f) => `-rw-r--r--   1 ${user.padEnd(8)} ${user.padEnd(8)} ${String(byteLength(f.content)).padStart(6)} ${f.name}`)
    .join('\n')
}

// ── FTP ──────────────────────────────────────────────────────────────────────

export interface FtpOptions {
  banner: string           // e.g. "File Server ready"
  user: string
  password: string
  clientIp: string
  dataPort: number         // client port the server connects back to (active mode)
  files: StoredFile[]
  action: FileAction
}

/** The PORT argument: h1,h2,h3,h4,p1,p2 with port = p1 × 256 + p2. */
export function portArgument(ip: string, port: number): string {
  return `${ip.split('.').join(',')},${Math.floor(port / 256)},${port % 256}`
}

/**
 * An FTP session (active mode). Control on port 21; the data connection is opened by the
 * server from port 20 to the client's PORT. Everything — password and file — in the clear.
 */
export function ftpSession(o: FtpOptions): Step[] {
  const file = o.action.cmd === 'get' ? o.files.find((f) => f.name === (o.action as { file: string }).file) : undefined
  const dataPayload = o.action.cmd === 'ls' ? listing(o.files, o.user) : file?.content ?? ''
  const what = o.action.cmd === 'ls' ? 'file list' : `${file?.name} (${byteLength(dataPayload)} bytes)`
  const dataOverride = { serverPort: FTP_DATA_PORT, clientPort: o.dataPort }

  const steps: Step[] = [
    s2c('FTP', '220', `220 ${o.banner}`, undefined, { lines: [out(`220 ${o.banner}`)] }),
    c2s('FTP', `USER ${o.user}`, `USER ${o.user}`, undefined, { lines: [out(`Name: ${o.user}`)] }),
    s2c('FTP', '331', `331 Password required for ${o.user}`, undefined, { lines: [out(`331 Password required for ${o.user}`)] }),
    c2s('FTP', 'PASS', `PASS ${o.password}`, undefined, { lines: [out('Password: ********')] }),
    s2c('FTP', '230', '230 Login successful', undefined, { lines: [out('230 Login successful')] }),
    c2s('FTP', 'PORT', `PORT ${portArgument(o.clientIp, o.dataPort)}`, undefined, {
      lines: [out(o.action.cmd === 'ls' ? 'ftp> ls' : `ftp> get ${o.action.file}`)],
    }),
    s2c('FTP', '200', '200 PORT command successful'),
  ]

  if (o.action.cmd === 'get' && !file) {
    const missing = `550 ${o.action.file}: No such file`
    steps.push(
      c2s('FTP', 'RETR', `RETR ${o.action.file}`),
      s2c('FTP', '550', missing, undefined, { lines: [err(missing)] }),
    )
  } else {
    steps.push(
      o.action.cmd === 'ls' ? c2s('FTP', 'LIST', 'LIST') : c2s('FTP', 'RETR', `RETR ${o.action.file}`),
      s2c('FTP', '150', `150 Opening data connection for ${what}`, undefined, {
        lines: [
          info(`ⓘ Data connection: the server connects from port ${FTP_DATA_PORT} (active mode).`),
          out(`150 Opening data connection for ${what}`),
        ],
      }),
      // The data connection, opened by the server
      ...tcpOpenFromServer().map((s) => ({ ...s, ...dataOverride })),
      {
        dir: 's2c', transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'FTP-DATA', label: o.action.cmd === 'ls' ? 'LIST data' : file!.name.slice(0, 14),
        info: `FTP Data: ${byteLength(dataPayload)} bytes (PORT) (${o.action.cmd === 'ls' ? 'LIST' : `RETR ${file!.name}`})`,
        payload: dataPayload,
        lines: o.action.cmd === 'ls' ? dataPayload.split('\n').map((l) => out(l)) : [],
        ...dataOverride,
      },
      ...tcpClose(true).map((s) => ({ ...s, ...dataOverride })),
      s2c('FTP', '226', '226 Transfer complete', undefined, { lines: [out('226 Transfer complete')] }),
    )
  }

  steps.push(
    c2s('FTP', 'QUIT', 'QUIT'),
    s2c('FTP', '221', '221 Goodbye', undefined, {
      lines: [out('221 Goodbye'), info('ⓘ Open the packet capture: find the PASS packet and the FTP-DATA packet.')],
    }),
  )
  return steps
}

export function cmdFtp(args: string[], ctx: TermContext): Lines {
  const host = args[0]
  const action = parseFileAction(args.slice(1))
  if (!host || !action) return [err('Usage: ftp <host> [ls | get <file>]   e.g. ftp files.careconnect.example get referrals.csv')]

  const t = connectTo(host, ctx, {
    unresolved: [err(`ftp: ${host}: Name or service not known`)],
    noRoute: [err(`ftp: connect: No route to host`)],
  })
  if (isFailure(t)) return t.lines

  const port = portOf('ftp')
  const intro = info('ⓘ FTP control connection on port 21 (TCP). Username, password and file all cross the network unencrypted.')
  if (!serviceUp(t, 'ftp')) {
    return [intro, ...refuse(t, port, ctx, [err(`ftp: connect to address ${t.r.ip}: Connection refused`)])]
  }

  const account = t.server.data.account ?? DEFAULT_ACCOUNT
  const self = ctx.nodes.find((n) => n.id === ctx.selfId)!
  const clientPort = ephemeralPort()
  let dataPort = ephemeralPort()
  while (dataPort === clientPort) dataPort = ephemeralPort()

  const open = tcpOpen()
  open[2]!.lines = [out(`Connected to ${host} (${t.r.ip}).`)]
  const steps = [
    ...open,
    ...ftpSession({
      banner: `${t.server.data.label} ready`,
      user: account.user,
      password: account.password,
      clientIp: self.data.ip,
      dataPort,
      files: t.server.data.files ?? [],
      action,
    }),
  ]
  return [intro, ...play(t, port, steps, ctx, clientPort)]
}

// ── SFTP ─────────────────────────────────────────────────────────────────────

export interface SftpOptions {
  host: string
  ip: string
  user: string
  password: string
  fingerprint: string
  files: StoredFile[]
  action: FileAction
}

export const SSH_VERSION = 'SSH-2.0-OpenSSH_9.6'

/**
 * SFTP inside SSH (port 22). Version banners and the key exchange are readable;
 * everything after it — the password included — is encrypted.
 */
export function sftpSession(o: SftpOptions): Step[] {
  const home = `/home/${o.user}`
  const file = o.action.cmd === 'get' ? o.files.find((f) => f.name === (o.action as { file: string }).file) : undefined
  const enc = (dir: 'c2s' | 's2c', label: string, payload: string, lines?: Lines): Step => ({
    dir, transport: 'TCP', tcpFlags: 'PSH, ACK', app: 'SSH', label,
    info: dir === 'c2s' ? 'Client: Encrypted packet' : 'Server: Encrypted packet',
    payload, encrypted: true, lines,
  })

  const steps: Step[] = [
    c2s('SSH', 'SSH-2.0', SSH_VERSION, `Client: Protocol (${SSH_VERSION})`),
    s2c('SSH', 'SSH-2.0', SSH_VERSION, `Server: Protocol (${SSH_VERSION})`),
    c2s('SSH', 'KEXINIT', 'Key exchange: agreeing algorithms (list of supported methods)', 'Client: Key Exchange Init'),
    s2c('SSH', 'KEXINIT', 'Key exchange: agreeing algorithms (list of supported methods)', 'Server: Key Exchange Init'),
    c2s('SSH', 'KEX init', "Key exchange: the client's public value", 'Client: Elliptic Curve Diffie-Hellman Key Exchange Init'),
    s2c('SSH', 'KEX reply', `Key exchange: the server's public value\nServer host key (public): ssh-ed25519\nHost key fingerprint: SHA256:${o.fingerprint}`,
      'Server: Elliptic Curve Diffie-Hellman Key Exchange Reply, New Keys', {
        lines: [
          out(`The authenticity of host '${o.host} (${o.ip})' can't be established.`),
          out(`ED25519 key fingerprint is SHA256:${o.fingerprint}.`),
          out(`Warning: Permanently added '${o.host}' to the list of known hosts.`),
        ],
      }),
    enc('c2s', '🔒 auth', `user ${o.user}, password ${o.password}`, [out(`${o.user}@${o.host}'s password: ********`)]),
    enc('s2c', '🔒 OK', 'Authentication successful', [out(`Connected to ${o.host}.`)]),
  ]

  if (o.action.cmd === 'ls') {
    const names = o.files.map((f) => f.name)
    steps.push(
      enc('c2s', '🔒 open', `SSH_FXP_OPENDIR ${home}`, [out('sftp> ls')]),
      enc('c2s', '🔒 read', 'SSH_FXP_READDIR'),
      enc('s2c', '🔒 data', listing(o.files, o.user), [out(names.join('  ') || '(empty)')]),
    )
  } else if (!file) {
    steps.push(
      enc('c2s', '🔒 open', `SSH_FXP_OPEN ${home}/${o.action.file}`, [out(`sftp> get ${o.action.file}`)]),
      enc('s2c', '🔒 status', 'SSH_FX_NO_SUCH_FILE: No such file', [err(`File "${home}/${o.action.file}" not found.`)]),
    )
  } else {
    const size = byteLength(file.content)
    steps.push(
      enc('c2s', '🔒 open', `SSH_FXP_OPEN ${home}/${file.name}`, [out(`sftp> get ${file.name}`)]),
      enc('c2s', '🔒 read', `SSH_FXP_READ ${home}/${file.name}`),
      enc('s2c', '🔒 data', file.content, [
        out(`Fetching ${home}/${file.name} to ${file.name}`),
        out(`${file.name.padEnd(37)} 100%  ${String(size).padStart(4)}     1.2KB/s   00:00`),
      ]),
    )
  }
  steps.push(enc('c2s', '🔒 close', 'SSH_FXP_CLOSE; disconnect', [
    info('ⓘ Compare with FTP in the packet capture: which details can a wiretap still read?'),
  ]))
  return steps
}

export function cmdSftp(args: string[], ctx: TermContext): Lines {
  const host = args[0]
  const action = parseFileAction(args.slice(1))
  if (!host || !action) return [err('Usage: sftp <host> [ls | get <file>]   e.g. sftp files.careconnect.example get referrals.csv')]

  const t = connectTo(host, ctx, {
    unresolved: [err(`ssh: Could not resolve hostname ${host}: Name or service not known`), out('Connection closed')],
    noRoute: [err(`ssh: connect to host ${host} port 22: No route to host`), out('Connection closed')],
  })
  if (isFailure(t)) return t.lines

  const port = portOf('ssh')
  const intro = info('ⓘ SFTP runs inside SSH on port 22 (TCP). After the key exchange, everything is encrypted — including the password.')
  if (!serviceUp(t, 'ssh')) {
    return [intro, ...refuse(t, port, ctx, [err(`ssh: connect to host ${host} port 22: Connection refused`), out('Connection closed')])]
  }

  const account = t.server.data.account ?? DEFAULT_ACCOUNT
  const steps = [
    ...tcpOpen(),
    ...sftpSession({
      host, ip: t.r.ip,
      user: account.user, password: account.password,
      fingerprint: hostKeyFingerprint(t.server.id),
      files: t.server.data.files ?? [],
      action,
    }),
  ]
  return [intro, ...play(t, port, steps, ctx)]
}
