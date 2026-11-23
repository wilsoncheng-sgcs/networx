import type { Node, Edge } from '@xyflow/react'
import type { ServiceId } from '../simulation/services'


export type DeviceType =
  | 'pc'
  | 'laptop'
  | 'server'
  | 'router'
  | 'switch'
  | 'hub'
  | 'wap'
  | 'firewall'
  | 'gateway'
  | 'dns'
  | 'web'
  | 'cloud'
  | 'mail'
  | 'file'

export interface RouteEntry {
  destination: string
  subnet: string
  gateway: string
  iface: string
  metric: number
}

export interface MacEntry {
  mac: string
  port: string
  vlan: number
}

export interface ArpEntry {
  ip: string
  mac: string
  iface: string
}

export interface DnsRecord {
  id: string
  hostname: string
  ip: string
}

export interface FirewallRule {
  id: string
  direction: 'in' | 'out'
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'ANY'
  srcIp: string
  dstIp: string
  port: string
  action: 'allow' | 'deny'
}

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'info'
  text: string
  /** Print this many ms after the command runs (timed with the packet animation). Absent = immediately. */
  delayMs?: number
}

export interface MailMessage { id: string; from: string; to: string; subject: string; body: string; seen: boolean }
export interface Mailbox { address: string; password: string; messages: MailMessage[] }
export interface StoredFile { name: string; content: string }

export type CertificateState = 'valid' | 'self-signed' | 'expired' | 'wrong-name'

export interface NodeData extends Record<string, unknown> {
  label: string
  deviceType: DeviceType
  ip: string
  wanIp: string
  subnet: string
  gateway: string
  mac: string
  isOn: boolean
  // Router
  routingTable: RouteEntry[]
  // Router DHCP server
  dhcpEnabled: boolean
  dhcpPool: string  // last-octet range, e.g. "100-200"
  // Switch
  macTable: MacEntry[]
  // Host/router ARP cache
  arpTable: ArpEntry[]
  // WAP
  ssid: string
  wpaKey: string
  band: '2.4GHz' | '5GHz'
  // Firewall
  rules: FirewallRule[]
  // DNS server records
  dnsRecords: DnsRecord[]
  // Web server hosted page
  pageContent: string
  // Terminal history (pc, laptop, server)
  termHistory: TerminalLine[]
  // Extra info
  notes: string
  // ── SGCS protocols extension (all optional; filled by normaliseNode) ──
  services?: Partial<Record<ServiceId, boolean>>   // overrides of the service defaults
  certificate?: CertificateState                    // web, mail (Phase 2 UI; default 'valid')
  redirectHttp?: boolean                            // web (Phase 2)
  files?: StoredFile[]                              // file server
  account?: { user: string; password: string }      // file server login (FTP and SFTP)
  mailDomain?: string                               // mail server, e.g. 'careconnect.example'
  mailboxes?: Mailbox[]                             // mail server
  localMail?: MailMessage[]                         // any client: mail downloaded by POP3
}

export type NetNode = Node<NodeData>
export type NetEdge = Edge

export type PanelType = 'config' | 'terminal' | 'browser' | 'info' | null

export interface PacketAnim {
  id: string
  edgeId: string
  protocol: 'ARP' | 'ICMP' | 'HTTP' | 'DNS' | 'TCP' | 'UDP' | 'TLS' | 'FTP' | 'SSH' | 'SMTP' | 'POP3' | 'IMAP'
  label: string
  delayMs: number
  durationMs: number
  reverse?: boolean
}

export type AnimSpeed = 0.5 | 1 | 3 | 'instant'

/** Application protocol of a captured packet; null for pure TCP control segments (SYN etc.). */
export type AppProtocol =
  | 'DNS' | 'HTTP' | 'TLS' | 'FTP' | 'FTP-DATA' | 'SSH' | 'SMTP' | 'POP3' | 'IMAP' | 'ICMP' | 'ARP' | null

export interface CaptureRecord {
  no: number
  timeMs: number
  conversationId: string
  stepIndex: number
  srcIp: string; srcPort?: number; dstIp: string; dstPort?: number
  srcMac: string; dstMac: string          // first hop of the leg
  transport: 'TCP' | 'UDP' | 'ICMP' | 'ARP'
  tcpFlags?: string
  app: AppProtocol
  info: string
  payload?: string                        // what is on the wire (plaintext; for encrypted steps only the teacher view shows it)
  cleartext?: string                      // readable part of a partly-encrypted record (TLS ServerHello)
  note?: string                           // extra line for the detail pane (e.g. a Base64 decode)
  encrypted: boolean
  length: number
}

/** A capture record waiting to be appended `delayMs` after the command ran. */
export interface PendingCapture extends Omit<CaptureRecord, 'no' | 'timeMs'> {
  delayMs: number
}

/** A finished TCP connection, for plain `netstat`. */
export interface ConnRecord {
  localIp: string
  localPort: number
  remoteIp: string
  remotePort: number
}
