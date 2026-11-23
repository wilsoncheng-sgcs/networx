import type { DeviceType, NetNode } from '../types'

/**
 * The single source of truth for application services and their ports.
 * Every command, the Services tab and `ss` read from this table.
 */

export type ServiceId =
  | 'dns' | 'http' | 'https' | 'ftp' | 'ssh'
  | 'smtp' | 'submission' | 'smtps' | 'pop3' | 'pop3s' | 'imap' | 'imaps'

export interface ServiceDef {
  id: ServiceId
  name: string            // shown in ss output and the Services tab
  protocol: string        // application protocol name, e.g. 'HTTPS'
  transport: 'TCP' | 'UDP'
  port: number
  secure: boolean         // true = encrypted (TLS or SSH)
  description: string     // one line, shown in the Services tab
  defaultOn: DeviceType[] // device types that run it by default
}

export const SERVICES: ServiceDef[] = [
  { id: 'dns',        name: 'dns',        protocol: 'DNS',           transport: 'UDP', port: 53,  secure: false, defaultOn: ['dns'],
    description: 'Answers “what is the IP address of this name?”' },
  { id: 'http',       name: 'http',       protocol: 'HTTP',          transport: 'TCP', port: 80,  secure: false, defaultOn: ['web'],
    description: 'Web pages, unencrypted' },
  { id: 'https',      name: 'https',      protocol: 'HTTPS',         transport: 'TCP', port: 443, secure: true,  defaultOn: ['web'],
    description: 'Web pages over TLS: encrypted, server authenticated by certificate' },
  { id: 'ftp',        name: 'ftp',        protocol: 'FTP',           transport: 'TCP', port: 21,  secure: false, defaultOn: ['file'],
    description: 'File transfer. Control on 21; data on 20 (active mode). Unencrypted, including the password' },
  { id: 'ssh',        name: 'ssh',        protocol: 'SSH / SFTP',    transport: 'TCP', port: 22,  secure: true,  defaultOn: ['file', 'web', 'mail', 'dns', 'server'],
    description: 'Encrypted remote login (SSH) and file transfer (SFTP runs inside SSH)' },
  { id: 'smtp',       name: 'smtp',       protocol: 'SMTP',          transport: 'TCP', port: 25,  secure: false, defaultOn: ['mail'],
    description: 'Mail server → mail server relay' },
  { id: 'submission', name: 'submission', protocol: 'SMTP',          transport: 'TCP', port: 587, secure: false, defaultOn: ['mail'],
    description: 'Mail client → its own mail server (sending)' },
  { id: 'smtps',      name: 'smtps',      protocol: 'SMTP over TLS', transport: 'TCP', port: 465, secure: true,  defaultOn: ['mail'],
    description: 'Sending with TLS from the start' },
  { id: 'pop3',       name: 'pop3',       protocol: 'POP3',          transport: 'TCP', port: 110, secure: false, defaultOn: ['mail'],
    description: 'Download mail to one device (usually deleted from the server)' },
  { id: 'pop3s',      name: 'pop3s',      protocol: 'POP3 over TLS', transport: 'TCP', port: 995, secure: true,  defaultOn: ['mail'],
    description: 'POP3 inside TLS' },
  { id: 'imap',       name: 'imap',       protocol: 'IMAP',          transport: 'TCP', port: 143, secure: false, defaultOn: ['mail'],
    description: 'Read mail kept on the server; syncs across devices' },
  { id: 'imaps',      name: 'imaps',      protocol: 'IMAP over TLS', transport: 'TCP', port: 993, secure: true,  defaultOn: ['mail'],
    description: 'IMAP inside TLS' },
]

/** FTP's data connection port (active mode). Not a separate service. */
export const FTP_DATA_PORT = 20

export function serviceById(id: ServiceId): ServiceDef {
  const def = SERVICES.find((s) => s.id === id)
  if (!def) throw new Error(`Unknown service ${id}`)
  return def
}

/** Services a device type is able to run (shown in its Services tab). */
export function servicesFor(type: DeviceType): ServiceDef[] {
  return SERVICES.filter((s) => s.defaultOn.includes(type))
}

/** Is `id` listening on this node? Node override first, else the type default. Off nodes listen on nothing. */
export function isListening(node: NetNode, id: ServiceId): boolean {
  if (!node.data.isOn) return false
  // Internet hosts (the cloud node) answer HTTP and HTTPS only
  if (node.data.deviceType === 'cloud') return id === 'http' || id === 'https'
  const override = node.data.services?.[id]
  if (override !== undefined) return override
  return serviceById(id).defaultOn.includes(node.data.deviceType)
}

export function listeningServices(node: NetNode): ServiceDef[] {
  return SERVICES.filter((s) => isListening(node, s.id))
}
