import type { NodeData, DeviceType, NetNode, NetEdge, Mailbox, StoredFile } from '../types'
import { defaultDnsServer, PUBLIC_RESOLVER_IP } from './resolve'
import { HOST_TYPES } from './routing'
import { normaliseRecord } from './dns'

let ipCounter = 10

function nextIp(subnet = '192.168.1') {
  return `${subnet}.${++ipCounter}`
}

function randomMac() {
  return Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join(':')
}

const DEVICE_LABELS: Record<DeviceType, string> = {
  pc: 'PC',
  laptop: 'Laptop',
  server: 'Server',
  router: 'Router',
  switch: 'Switch',
  hub: 'Hub',
  wap: 'Access Point',
  firewall: 'Firewall',
  gateway: 'Home Gateway',
  dns: 'DNS Server',
  web: 'Web Server',
  cloud: 'Internet',
  mail: 'Mail Server',
  file: 'File Server',
}

// ── Sample content for the file and mail servers ─────────────────────────────

/** Fictional and deliberately sensitive: the point is what plain FTP exposes. */
export const REFERRALS_CSV = [
  'patient_id,name,referral_to,reason',
  'P-1042,Alex Tran,Physiotherapy,Knee reconstruction rehab',
  'P-1043,Sam Okafor,Cardiology,Irregular heartbeat',
  'P-1044,Jordan Lee,Psychology,Anxiety',
  'P-1045,Riley Walsh,Dermatology,Suspicious mole',
  'P-1046,Casey Ng,Endocrinology,Type 2 diabetes review',
].join('\n') + '\n'

export function defaultFiles(): StoredFile[] {
  return [
    { name: 'readme.txt', content: 'Shared clinic files. Patient data: handle with care.\n' },
    { name: 'referrals.csv', content: REFERRALS_CSV },
  ]
}

export const DEFAULT_ACCOUNT = { user: 'clinic', password: 'Clinic2026!' }

export function defaultMailboxes(): Mailbox[] {
  return [{
    address: 'user@example.local',
    password: 'password123',
    messages: [{
      id: 'm1',
      from: 'postmaster@example.local',
      to: 'user@example.local',
      subject: 'Welcome to your mailbox',
      body: 'This mailbox lives on the mail server. Try pop3 or imap from a client.',
      seen: false,
    }],
  }]
}

export function makeDefaultData(type: DeviceType, id: string): NodeData {
  const base: NodeData = {
    label: `${DEVICE_LABELS[type]} ${id.split('-')[1]}`,
    deviceType: type,
    ip: '',
    wanIp: '',
    subnet: '255.255.255.0',
    gateway: '192.168.1.1',
    mac: randomMac(),
    isOn: true,
    routingTable: [],
    dhcpEnabled: false,
    dhcpPool: '100-200',
    macTable: [],
    arpTable: [],
    ssid: 'NetworX-WiFi',
    wpaKey: 'password123',
    band: '2.4GHz',
    rules: [],
    dnsRecords: [],
    pageContent: '',
    termHistory: [],
    notes: '',
    services: {},
    localMail: [],
  }

  switch (type) {
    case 'router':
      base.ip = nextIp()
      base.routingTable = [
        { destination: '0.0.0.0', subnet: '0.0.0.0', gateway: '0.0.0.0', iface: 'eth0', metric: 0 },
      ]
      base.dhcpEnabled = true
      base.dhcpPool = '100-200'
      break
    case 'switch':
    case 'hub':
      base.ip = ''
      base.subnet = ''
      break
    case 'wap':
      base.ip = nextIp()
      base.ssid = 'NetworX-WiFi'
      break
    case 'firewall':
      base.ip = nextIp()
      // Inbound: only SSH, HTTPS and HTTP are let in; outbound and replies are allowed (spec §8)
      base.rules = [
        { id: 'r1', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '22',  action: 'allow' },
        { id: 'r2', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '443', action: 'allow' },
        { id: 'r3', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '80',  action: 'allow' },
        { id: 'r4', direction: 'in', protocol: 'ANY', srcIp: '*', dstIp: '*', port: '*',   action: 'deny' },
      ]
      break
    case 'gateway':
      base.ip = nextIp()
      base.routingTable = [
        { destination: '0.0.0.0', subnet: '0.0.0.0', gateway: '0.0.0.0', iface: 'eth0', metric: 0 },
      ]
      base.dhcpEnabled = true
      base.dhcpPool = '100-200'
      base.ssid = 'HomeNet-5G'
      base.wpaKey = 'password123'
      base.band = '5GHz'
      // A typical home gateway: nothing from the internet gets in; outbound and replies are allowed (spec §8)
      base.rules = [
        { id: 'r1', direction: 'in', protocol: 'ANY', srcIp: '*', dstIp: '*', port: '*', action: 'deny' },
      ]
      break
    case 'dns':
      base.ip = '192.168.1.53'
      base.label = 'DNS Server'
      base.dnsRecords = [
        { id: 'dr1', name: 'www.school.local', type: 'A', value: '192.168.1.80', ttl: 3600 },
        { id: 'dr2', name: 'intranet.school.local', type: 'A', value: '192.168.1.81', ttl: 3600 },
      ]
      break
    case 'web':
      base.ip = nextIp()
      base.label = 'Web Server'
      base.certificate = 'valid'
      base.redirectHttp = false
      base.pageContent = `<!DOCTYPE html>\n<html>\n<head>\n  <title>My Web Server</title>\n</head>\n<body>\n  <h1>Welcome to My Web Server</h1>\n  <p>This page is being served from the web server node.</p>\n  <p>Edit this content in the Configure panel &rarr; Page tab.</p>\n</body>\n</html>`
      break
    case 'cloud':
      base.ip = '0.0.0.0'
      base.label = 'Internet'
      base.subnet = ''
      base.gateway = ''
      base.notes = 'Represents the public internet / ISP. Connect a router\'s WAN port here.'
      break
    case 'file':
      base.ip = nextIp()
      base.label = 'File Server'
      base.account = { ...DEFAULT_ACCOUNT }
      base.files = defaultFiles()
      break
    case 'mail':
      base.ip = nextIp()
      base.label = 'Mail Server'
      base.certificate = 'valid'
      base.mailDomain = 'example.local'
      base.mailboxes = defaultMailboxes()
      break
    default:
      base.ip = nextIp()
  }

  return base
}

/**
 * Fill every missing field with its default, so saves and exports from older
 * versions (without the protocol fields) load without errors. Existing values win.
 */
export function normaliseNode(node: NetNode): NetNode {
  const type = node.data?.deviceType
  if (!type || !(type in DEVICE_LABELS)) return node
  const defaults = makeDefaultData(type, node.id)
  const data = { ...node.data } as Record<string, unknown>
  for (const [key, value] of Object.entries(defaults)) {
    if (data[key] === undefined) data[key] = value
  }
  // DNS records saved before Phase 4 were { hostname, ip }: they become A records
  if (Array.isArray(data.dnsRecords)) data.dnsRecords = (data.dnsRecords as Parameters<typeof normaliseRecord>[0][]).map(normaliseRecord)
  return { ...node, data: data as NodeData }
}

/**
 * Normalise every node, then fill the settings that depend on the rest of the network:
 * each host's DNS server (the network's DNS server node, else 8.8.8.8 when there is an Internet node,
 * else none), and the DNS server a router or gateway hands out by DHCP.
 */
export function normaliseNetwork(nodes: NetNode[], edges: NetEdge[]): NetNode[] {
  const all = nodes.map(normaliseNode)
  const dnsNode = all.find((n) => n.data.deviceType === 'dns' && n.data.ip)
  const forClients = dnsNode?.data.ip ?? (all.some((n) => n.data.deviceType === 'cloud') ? PUBLIC_RESOLVER_IP : '')
  return all.map((n) => {
    if (HOST_TYPES.includes(n.data.deviceType) && typeof n.data.dnsServer !== 'string') {
      return { ...n, data: { ...n.data, dnsServer: defaultDnsServer(n, all, edges) } }
    }
    if ((n.data.deviceType === 'router' || n.data.deviceType === 'gateway') && typeof n.data.dhcpDns !== 'string') {
      return { ...n, data: { ...n.data, dhcpDns: forClients } }
    }
    return n
  })
}
