import type { NetNode, NetEdge, NodeData, DeviceType } from '../types'
import { defaultFiles } from './defaults'

function mac(s: string): string { return s } // fixed MACs for presets

function node(
  id: string,
  deviceType: DeviceType,
  label: string,
  ip: string,
  position: { x: number; y: number },
  extra: Partial<NodeData> = {},
): NetNode {
  return {
    id,
    type: 'device',
    position,
    data: {
      label,
      deviceType,
      ip,
      wanIp: '',
      subnet: ['switch', 'hub', 'cloud'].includes(deviceType) ? '' : '255.255.255.0',
      gateway: ['switch', 'hub', 'cloud', 'router', 'gateway'].includes(deviceType) ? '' : ip.replace(/\.\d+$/, '.1'),
      mac: mac(`aa:bb:cc:dd:${id.slice(-2).padStart(2, '0')}:01`),
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
      pageContent: deviceType === 'web'
        ? `<!DOCTYPE html>\n<html>\n<head>\n  <title>${label}</title>\n</head>\n<body>\n  <h1>Welcome to ${label}</h1>\n  <p>This page is served from <strong>${ip}</strong>.</p>\n  <p>Edit this content in the Configure panel &rarr; Page tab.</p>\n</body>\n</html>`
        : '',
      termHistory: [],
      notes: '',
      ...extra,
    },
  }
}

/**
 * Join each link at the sides that face each other (right → left, bottom → top …) instead of
 * React Flow's default top → top, so lines don't loop over neighbouring devices.
 */
function sideHandles(nodes: NetNode[], edges: NetEdge[]): NetEdge[] {
  const pos = new Map(nodes.map((n) => [n.id, n.position]))
  return edges.map((e) => {
    const a = pos.get(e.source), b = pos.get(e.target)
    if (!a || !b) return e
    const dx = b.x - a.x, dy = b.y - a.y
    const [sourceHandle, targetHandle] = Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? ['sr', 'l'] : ['sl', 'r'])
      : (dy >= 0 ? ['sb', 't'] : ['st', 'b'])
    return { ...e, sourceHandle, targetHandle }
  })
}

function edge(id: string, source: string, target: string, wireless = false): NetEdge {
  return {
    id,
    source,
    target,
    animated: wireless,
    style: wireless
      ? { stroke: '#6366f1', strokeDasharray: '6 3' }
      : { stroke: '#374151' },
    label: wireless ? 'Wi-Fi' : undefined,
  }
}

export interface Preset {
  id: string
  name: string
  description: string
  nodes: NetNode[]
  edges: NetEdge[]
}

// ─── 0. CareConnect (SGCS protocols lesson) ──────────────────────────────────
// Domain careconnect.example is reserved (RFC 2606). Public servers on 203.0.113.0/24 and the
// home and clinic WANs on 198.51.100.0/24 are documentation ranges (RFC 5737).

const CARECONNECT_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>CareConnect Medical Centre</title>
</head>
<body style="font-family:sans-serif;margin:0;color:#1f2937">
  <header style="background:#0f766e;color:white;padding:16px 24px">
    <h1 style="margin:0;font-size:22px">CareConnect Medical Centre</h1>
    <p style="margin:4px 0 0;font-size:13px">General practice · Pathology · Referrals</p>
  </header>
  <main style="padding:16px 24px">
    <h2 style="font-size:17px">Book an appointment</h2>
    <p>Choose a doctor and a time that suits you.</p>
    <p><a href="#" style="background:#0f766e;color:white;padding:8px 14px;border-radius:6px;text-decoration:none">Book now</a></p>
    <p style="font-size:12px;color:#6b7280">A fictional clinic for the Networx protocols lab.</p>
  </main>
</body>
</html>`

const careConnect: Preset = {
  id: 'careconnect',
  name: 'CareConnect',
  description: "CareConnect's servers, a patient at home and a clinic. Use with the packet capture: follow a web request, compare FTP with SFTP, and POP3 with IMAP.",
  nodes: [
    node('net',       'cloud',   'Internet',           '0.0.0.0',       { x: 340, y: 150 },
      { mac: 'aa:bb:cc:00:00:01', notes: 'The public internet. Try: nslookup www.careconnect.example from any device.' }),

    // Home (left)
    node('homegw',    'gateway', 'Home Gateway',       '192.168.1.1',   { x: 170, y: 150 },
      { mac: 'aa:bb:cc:01:00:01', wanIp: '198.51.100.23', dhcpEnabled: true, dhcpPool: '100-200',
        ssid: 'HomeNet', wpaKey: 'password123', band: '5GHz',
        notes: "The patient's home router. Try: ping 192.168.1.1 from the Patient's Laptop." }),
    node('patient',   'laptop',  "Patient's Laptop",   '192.168.1.101', { x: -60, y: 150 },
      { mac: 'aa:bb:cc:01:01:01',
        notes: 'Try: curl -v http://www.careconnect.example then curl -v https://www.careconnect.example' }),

    // CareConnect servers (top right)
    node('ccrouter',  'router',  'CareConnect Router', '203.0.113.1',   { x: 520, y: 40 },
      { mac: 'aa:bb:cc:02:00:01', wanIp: '198.51.100.1',
        notes: "Try: traceroute www.careconnect.example from the Patient's Laptop." }),
    node('ccsw',      'switch',  'Server Switch',      '',              { x: 690, y: 20 },
      { mac: 'aa:bb:cc:02:00:02', notes: "Try: run a curl, then open this switch's MAC Table." }),
    node('ccdns',     'dns',     'DNS Server',         '203.0.113.53',  { x: 880, y: -205 },
      { mac: 'aa:bb:cc:02:00:53',
        // 2001:db8::/32 is the IPv6 documentation prefix (RFC 3849)
        dnsRecords: [
          { id: 'cc1', name: 'careconnect.example',       type: 'A',     value: '203.0.113.80',             ttl: 3600 },
          { id: 'cc2', name: 'careconnect.example',       type: 'AAAA',  value: '2001:db8:cc::80',          ttl: 3600 },
          { id: 'cc3', name: 'www.careconnect.example',   type: 'CNAME', value: 'careconnect.example',      ttl: 300 },
          { id: 'cc4', name: 'mail.careconnect.example',  type: 'A',     value: '203.0.113.25',             ttl: 3600 },
          { id: 'cc5', name: 'files.careconnect.example', type: 'A',     value: '203.0.113.21',             ttl: 3600 },
          { id: 'cc6', name: 'ns1.careconnect.example',   type: 'A',     value: '203.0.113.53',             ttl: 3600 },
          { id: 'cc7', name: 'careconnect.example',       type: 'MX',    value: 'mail.careconnect.example', ttl: 3600, priority: 10 },
          { id: 'cc8', name: 'careconnect.example',       type: 'NS',    value: 'ns1.careconnect.example',  ttl: 3600 },
          { id: 'cc9', name: 'careconnect.example',       type: 'TXT',   value: '"v=spf1 mx -all"',         ttl: 3600 },
        ],
        notes: 'Try: nslookup files.careconnect.example (from any device).' }),
    node('ccweb',     'web',     'CareConnect Web',    '203.0.113.80',  { x: 880, y: -85 },
      { mac: 'aa:bb:cc:02:00:80', pageContent: CARECONNECT_PAGE,
        services: { http: true, https: true }, certificate: 'valid', redirectHttp: false,
        notes: "Try: curl -v https://www.careconnect.example (from the Patient's Laptop)." }),
    node('ccmail',    'mail',    'Mail Server',        '203.0.113.25',  { x: 880, y: 60 },
      { mac: 'aa:bb:cc:02:00:25', certificate: 'valid', mailDomain: 'careconnect.example',
        mailboxes: [
          { address: 'reception@careconnect.example', password: 'Front2026!', messages: [
            { id: 'r1', from: 'it@careconnect.example', to: 'reception@careconnect.example',
              subject: 'Welcome to CareConnect mail', body: 'Your mailbox is ready. Check it with imap or pop3.', seen: false },
          ] },
          { address: 'dr.nguyen@careconnect.example', password: 'Surgery2026!', messages: [
            { id: 'd1', from: 'pathology@careconnect.example', to: 'dr.nguyen@careconnect.example',
              subject: 'Pathology results ready — P-1043', body: 'Results for patient P-1043 are ready to review in the clinical system.', seen: false },
            { id: 'd2', from: 'practice.manager@careconnect.example', to: 'dr.nguyen@careconnect.example',
              subject: 'Rostering for next week', body: "Next week's roster is on the staff noticeboard. Please confirm your sessions.", seen: false },
          ] },
        ],
        notes: "Try: pop3 dr.nguyen@careconnect.example (from the Doctor's PC), then the same from the Doctor's Laptop." }),
    node('ccfile',    'file',    'File Server',        '203.0.113.21',  { x: 880, y: 200 },
      { mac: 'aa:bb:cc:02:00:21', services: { ftp: true, ssh: true },
        account: { user: 'clinic', password: 'Clinic2026!' }, files: defaultFiles(),
        notes: 'Try: ftp files.careconnect.example get referrals.csv, then sftp … (from the Reception PC).' }),

    // Clinic (bottom)
    node('clinicgw',  'gateway', 'Clinic Gateway',     '10.0.0.1',      { x: 340, y: 330 },
      { mac: 'aa:bb:cc:03:00:01', wanIp: '198.51.100.77', ssid: 'CareConnect-Staff', band: '5GHz',
        notes: 'Try: ping 10.0.0.1 from the Reception PC.' }),
    node('reception', 'pc',      'Reception PC',       '10.0.0.11',     { x: 170, y: 470 },
      { mac: 'aa:bb:cc:03:00:11', notes: 'Try: ftp files.careconnect.example get referrals.csv' }),
    node('doclaptop', 'laptop',  "Doctor's Laptop",    '10.0.0.12',     { x: 340, y: 490 },
      { mac: 'aa:bb:cc:03:00:12', notes: 'Try: imap dr.nguyen@careconnect.example' }),
    node('docpc',     'pc',      "Doctor's PC",        '10.0.0.13',     { x: 510, y: 470 },
      { mac: 'aa:bb:cc:03:00:13', notes: 'Try: pop3 dr.nguyen@careconnect.example' }),
  ],
  edges: [
    edge('cc-e1',  'patient',  'homegw', true),
    edge('cc-e2',  'homegw',   'net'),
    edge('cc-e3',  'net',      'ccrouter'),
    edge('cc-e4',  'ccrouter', 'ccsw'),
    edge('cc-e5',  'ccsw',     'ccdns'),
    edge('cc-e6',  'ccsw',     'ccweb'),
    edge('cc-e7',  'ccsw',     'ccmail'),
    edge('cc-e8',  'ccsw',     'ccfile'),
    edge('cc-e9',  'net',      'clinicgw'),
    edge('cc-e10', 'clinicgw', 'reception'),
    edge('cc-e11', 'clinicgw', 'docpc'),
    edge('cc-e12', 'clinicgw', 'doclaptop', true),
  ],
}

careConnect.edges = sideHandles(careConnect.nodes, careConnect.edges)
// Every host asks CareConnect's DNS server, and both gateways hand it out by DHCP (Phase 4 B1)
careConnect.nodes = careConnect.nodes.map((n) => {
  if (['pc', 'laptop', 'server', 'dns', 'web', 'mail', 'file'].includes(n.data.deviceType)) return { ...n, data: { ...n.data, dnsServer: '203.0.113.53' } }
  if (n.data.deviceType === 'gateway') return { ...n, data: { ...n.data, dhcpDns: '203.0.113.53' } }
  return n
})

// ─── 1. Simple Star (LAN only) ───────────────────────────────────────────────

const starLan: Preset = {
  id: 'star-lan',
  name: 'Star Topology (LAN)',
  description: 'Classic star topology: a central switch connecting four workstations. Good for exploring LAN basics, switch MAC tables, and ping.',
  nodes: [
    node('sw1',  'switch', 'Switch',  '',              { x: 320, y: 240 }),
    node('pc1',  'pc',     'PC 1',    '192.168.1.11',  { x: 120, y: 80  }),
    node('pc2',  'pc',     'PC 2',    '192.168.1.12',  { x: 520, y: 80  }),
    node('pc3',  'pc',     'PC 3',    '192.168.1.13',  { x: 120, y: 380 }),
    node('pc4',  'pc',     'PC 4',    '192.168.1.14',  { x: 520, y: 380 }),
  ],
  edges: [
    edge('e1', 'sw1', 'pc1'),
    edge('e2', 'sw1', 'pc2'),
    edge('e3', 'sw1', 'pc3'),
    edge('e4', 'sw1', 'pc4'),
  ],
}

// ─── 2. Home Network ─────────────────────────────────────────────────────────

const homeNetwork: Preset = {
  id: 'home-network',
  name: 'Home Network',
  description: 'Typical home broadband setup: ISP → Domestic Gateway (combined router, switch, WAP and firewall) → wired PCs and wireless laptop.',
  nodes: [
    node('cloud1',   'cloud',    'Internet',       '0.0.0.0',       { x: 20,  y: 230 },
      { notes: 'Represents your ISP and the public internet.' }),
    node('gw1',      'gateway',  'Home Gateway',   '192.168.1.1',   { x: 240, y: 230 },
      { wanIp: '82.1.2.3',
        routingTable: [
          { destination: '0.0.0.0',     subnet: '0.0.0.0',       gateway: '0.0.0.0', iface: 'eth0', metric: 0 },
          { destination: '192.168.1.0', subnet: '255.255.255.0', gateway: '0.0.0.0', iface: 'eth1', metric: 0 },
        ],
        dhcpEnabled: true,
        dhcpPool: '100-200',
        ssid: 'HomeNet-5G',
        wpaKey: 'supersecret',
        band: '5GHz',
        rules: [
          { id: 'r1', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '80',  action: 'allow' },
          { id: 'r2', direction: 'in', protocol: 'ANY', srcIp: '*', dstIp: '*', port: '*',   action: 'deny'  },
        ],
        notes: 'The box from your ISP. Combines router (NAT), switch (wired ports), Wi-Fi access point, and basic firewall in one unit. DHCP assigns IPs 192.168.1.100–200 to clients.' }),
    node('pc1',      'pc',       'Desktop PC',     '192.168.1.11',  { x: 500, y: 100 }),
    node('pc2',      'pc',       'Work PC',        '192.168.1.12',  { x: 500, y: 260 }),
    node('laptop1',  'laptop',   'Laptop',         '192.168.1.20',  { x: 500, y: 400 },
      { notes: 'Connected wirelessly to HomeNet-5G' }),
  ],
  edges: [
    edge('e1', 'cloud1', 'gw1'),
    edge('e2', 'gw1',    'pc1'),
    edge('e3', 'gw1',    'pc2'),
    edge('e4', 'gw1',    'laptop1', true),
  ],
}

// ─── 3. School Network ───────────────────────────────────────────────────────

const schoolNetwork: Preset = {
  id: 'school-network',
  name: 'School Network',
  description: 'School infrastructure: Internet → Firewall → Router → Core switch → servers + classroom switch + WAP. Demonstrates network segmentation and security.',
  nodes: [
    node('cloud1',  'cloud',    'Internet',       '0.0.0.0',        { x: 20,  y: 330 }),
    node('fw1',     'firewall', 'Firewall',       '10.0.0.1',       { x: 200, y: 330 },
      { rules: [
          { id: 'r1', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '80',  action: 'allow' },
          { id: 'r2', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '443', action: 'allow' },
          { id: 'r3', direction: 'in', protocol: 'TCP', srcIp: '*', dstIp: '*', port: '22',  action: 'deny'  },
          { id: 'r4', direction: 'in', protocol: 'ANY', srcIp: '*', dstIp: '*', port: '*',   action: 'deny'  },
        ] }),
    node('router1', 'router',   'Core Router',    '192.168.0.1',    { x: 390, y: 330 },
      { wanIp: '10.0.0.2',
        routingTable: [
          { destination: '0.0.0.0',     subnet: '0.0.0.0',       gateway: '10.0.0.1',    iface: 'eth0', metric: 0 },
          { destination: '192.168.0.0', subnet: '255.255.255.0', gateway: '0.0.0.0',     iface: 'eth1', metric: 0 },
        ],
        dhcpEnabled: true,
        dhcpPool: '100-200' }),
    node('sw-core', 'switch',   'Core Switch',    '',               { x: 580, y: 330 }),
    node('srv1',    'server',   'File Server',    '192.168.0.10',   { x: 780, y: 120 },
      { notes: 'Central file storage for the school. Accessible to all on the LAN.' }),
    node('dns1',    'dns',      'DNS Server',     '192.168.0.53',   { x: 780, y: 230 },
      { dnsRecords: [
          { id: 'dr1', name: 'www.school.local',      type: 'A', value: '192.168.0.80', ttl: 3600 },
          { id: 'dr2', name: 'files.school.local',    type: 'A', value: '192.168.0.10', ttl: 3600 },
          { id: 'dr3', name: 'intranet.school.local', type: 'A', value: '192.168.0.80', ttl: 3600 },
        ] }),
    node('web1',    'web',      'Web Server',     '192.168.0.80',   { x: 780, y: 340 }),
    node('sw-cls',  'switch',   'Classroom Switch','',              { x: 780, y: 460 }),
    node('wap1',    'wap',      'Wi-Fi AP',       '192.168.0.200',  { x: 780, y: 570 },
      { ssid: 'School-WiFi', wpaKey: 'education2024', band: '5GHz' }),
    node('pc1',     'pc',       'Teacher PC',     '192.168.0.101',  { x: 990, y: 400 }),
    node('pc2',     'pc',       'Student PC 1',   '192.168.0.102',  { x: 990, y: 500 }),
    node('laptop1', 'laptop',   'Student Laptop', '192.168.0.151',  { x: 990, y: 600 },
      { notes: 'Connects wirelessly to School-WiFi' }),
  ],
  edges: [
    edge('e1',  'cloud1',  'fw1'),
    edge('e2',  'fw1',     'router1'),
    edge('e3',  'router1', 'sw-core'),
    edge('e4',  'sw-core', 'srv1'),
    edge('e5',  'sw-core', 'dns1'),
    edge('e6',  'sw-core', 'web1'),
    edge('e7',  'sw-core', 'sw-cls'),
    edge('e8',  'sw-cls',  'wap1'),
    edge('e9',  'sw-cls',  'pc1'),
    edge('e10', 'sw-cls',  'pc2'),
    edge('e11', 'wap1',    'laptop1', true),
  ],
}

// ─── 4. Client-Server ────────────────────────────────────────────────────────

const clientServer: Preset = {
  id: 'client-server',
  name: 'Client-Server Model',
  description: 'A web server and DNS server on a LAN, with three client PCs. Try nslookup and curl from a PC terminal.',
  nodes: [
    node('sw1',   'switch', 'Switch',      '',              { x: 320, y: 280 }),
    node('dns1',  'dns',    'DNS Server',  '192.168.1.53',  { x: 100, y: 100 },
      { notes: 'Resolves domain names to IP addresses. Try: nslookup www.local',
        dnsRecords: [
          { id: 'dr1', name: 'www.local', type: 'A', value: '192.168.1.80', ttl: 3600 },
          { id: 'dr2', name: 'web.local', type: 'A', value: '192.168.1.80', ttl: 3600 },
        ] }),
    node('web1',  'web',    'Web Server',  '192.168.1.80',  { x: 540, y: 100 },
      { notes: 'Serves HTTP pages on port 80. Try: curl www.local from a PC terminal.' }),
    node('pc1',   'pc',     'Client 1',   '192.168.1.11',  { x: 100, y: 420 }),
    node('pc2',   'pc',     'Client 2',   '192.168.1.12',  { x: 320, y: 460 }),
    node('pc3',   'pc',     'Client 3',   '192.168.1.13',  { x: 540, y: 420 }),
  ],
  edges: [
    edge('e1', 'sw1', 'dns1'),
    edge('e2', 'sw1', 'web1'),
    edge('e3', 'sw1', 'pc1'),
    edge('e4', 'sw1', 'pc2'),
    edge('e5', 'sw1', 'pc3'),
  ],
}

// ─── 5. Mesh / Internet backbone ─────────────────────────────────────────────

const meshNetwork: Preset = {
  id: 'mesh-network',
  name: 'Mesh / WAN Topology',
  description: 'Three sites connected via routers with redundant paths — like the internet backbone. Shows how packets can take multiple routes.',
  nodes: [
    node('cloud1',   'cloud',  'Internet',       '0.0.0.0',       { x: 320, y: 30  }),
    // Site A
    node('routerA',  'router', 'Router A',       '10.1.0.1',      { x: 80,  y: 200 },
      { wanIp: '172.16.0.1', notes: 'Site A gateway. Connected to Site B and C routers, and to the internet.' }),
    node('swA',      'switch', 'Switch A',       '',              { x: 80,  y: 360 }),
    node('pcA1',     'pc',     'PC A1',          '10.1.0.11',     { x: -80, y: 460 }),
    node('pcA2',     'pc',     'PC A2',          '10.1.0.12',     { x: 80,  y: 480 }),
    // Site B
    node('routerB',  'router', 'Router B',       '10.2.0.1',      { x: 320, y: 200 },
      { wanIp: '172.16.0.2', notes: 'Site B gateway — central hub. Connected to all other routers.' }),
    node('swB',      'switch', 'Switch B',       '',              { x: 320, y: 360 }),
    node('srvB',     'server', 'Server B',       '10.2.0.10',     { x: 220, y: 480 }),
    node('pcB1',     'pc',     'PC B1',          '10.2.0.11',     { x: 420, y: 480 }),
    // Site C
    node('routerC',  'router', 'Router C',       '10.3.0.1',      { x: 560, y: 200 },
      { wanIp: '172.16.0.3', notes: 'Site C gateway. Multiple paths to reach other sites — demonstrates redundancy.' }),
    node('swC',      'switch', 'Switch C',       '',              { x: 560, y: 360 }),
    node('pcC1',     'pc',     'PC C1',          '10.3.0.11',     { x: 460, y: 480 }),
    node('pcC2',     'pc',     'PC C2',          '10.3.0.12',     { x: 660, y: 480 }),
  ],
  edges: [
    // Internet links
    edge('ei1', 'cloud1',  'routerA'),
    edge('ei2', 'cloud1',  'routerB'),
    edge('ei3', 'cloud1',  'routerC'),
    // Inter-router (mesh) links
    edge('er1', 'routerA', 'routerB'),
    edge('er2', 'routerB', 'routerC'),
    edge('er3', 'routerA', 'routerC'),
    // LAN links
    edge('ea1', 'routerA', 'swA'),
    edge('ea2', 'swA',     'pcA1'),
    edge('ea3', 'swA',     'pcA2'),
    edge('eb1', 'routerB', 'swB'),
    edge('eb2', 'swB',     'srvB'),
    edge('eb3', 'swB',     'pcB1'),
    edge('ec1', 'routerC', 'swC'),
    edge('ec2', 'swC',     'pcC1'),
    edge('ec3', 'swC',     'pcC2'),
  ],
}

export const PRESETS: Preset[] = [
  careConnect,
  starLan,
  homeNetwork,
  schoolNetwork,
  clientServer,
  meshNetwork,
]
