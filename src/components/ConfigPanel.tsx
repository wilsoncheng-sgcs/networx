import { useEffect, useState } from 'react'
import { X, Plus, Trash2, Power, RotateCcw, ChevronUp, ChevronDown, Pencil } from 'lucide-react'
import { useNetworkStore } from '../store'
import type { FirewallRule, DnsRecord, DnsRecordType, StoredFile, Mailbox, NetNode, CertificateState } from '../types'
import { DEFAULT_ACCOUNT, defaultMailboxes } from '../simulation/defaults'
import { PRESETS } from '../simulation/presets'
import { servicesFor, isListening } from '../simulation/services'
import { RECORD_TYPES, RECORD_HELP, DEFAULT_TTL, validateRecord, rdata } from '../simulation/dns'
import { dhcpRequest } from '../simulation/terminal'
import { announcement, parsePrefix, validateIspRoute, routePrefix, nextHopLabel, lanNetwork } from '../simulation/isp'
import * as clock from '../simulation/clock'
import { cacheArrived, flushDnsCache, serverCacheId, subscribeDnsCache } from '../simulation/dnsCache'


/** A copy of `list` with the item at `from` moved to `to`. */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const copy = [...list]
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item!)
  return copy
}

interface Props {
  nodeId: string
  onClose: () => void
}

function Field({ label, value, onChange, placeholder = '', mono = false, readOnly = false, testId }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  /** Shown but not editable (an address obtained by DHCP). */
  readOnly?: boolean
  testId?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</label>
      <input
        className={`border border-gray-200 rounded-md px-2.5 py-1.5 text-sm outline-none ${readOnly ? 'bg-gray-50 text-gray-500 cursor-default' : 'focus:ring-2 focus:ring-blue-300'} ${mono ? 'font-mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={readOnly ? '' : placeholder}
        readOnly={readOnly}
        title={readOnly ? 'Obtained by DHCP. Choose Manual to type an address.' : undefined}
        data-testid={testId}
      />
    </div>
  )
}

/**
 * The Internet node's Routing tab: the ISP's routes. A public network behind a router is reachable from
 * the internet only while a route here points at it.
 */
function IspRoutesTab({ node }: { node: NetNode }) {
  const { nodes, updateNodeData } = useNetworkStore()
  const routes = node.data.ispRoutes ?? []
  const [network, setNetwork] = useState('')
  const [nextHop, setNextHop] = useState('')
  const [error, setError] = useState('')

  const add = () => {
    const prefix = parsePrefix(network)
    if (!prefix) { setError('Write the network as an address and prefix length, e.g. 203.0.113.0/24.'); return }
    const route = { id: `isp${Date.now()}`, ...prefix, nextHop: nextHop.trim() }
    const problem = validateIspRoute(route, nodes)
    if (problem) { setError(problem); return }
    if (routes.some((r) => r.destination === route.destination && r.subnet === route.subnet)) {
      setError(`There is already a route for ${routePrefix(route)}. Delete it first to change it.`); return
    }
    updateNodeData(node.id, { ispRoutes: [...routes, route] })
    setNetwork(''); setNextHop(''); setError('')
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">ISP Routing Table</h3>
        <p className="text-xs text-gray-400 mt-1">
          The public networks the internet can reach, and the router each one is behind. A network with no route
          here can't be reached from the internet, even with public addresses. Private ranges (10.x, 172.16–31.x,
          192.168.x) are never carried. A router's WAN address is always reachable: it is on the ISP's own network.
        </p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-400 border-b border-gray-100">
            <th className="py-1 font-medium">Network</th>
            <th className="py-1 font-medium">Next hop</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => (
            <tr key={r.id} data-testid="isp-route-row" className="border-b border-gray-50">
              <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{routePrefix(r)}</td>
              <td className="py-1.5 font-mono [overflow-wrap:anywhere]">{nextHopLabel(r.nextHop, nodes)}</td>
              <td className="py-1.5 text-right">
                <button
                  data-testid="isp-delete"
                  title="Delete this route"
                  className="text-gray-300 hover:text-red-400 transition-colors"
                  onClick={() => updateNodeData(node.id, { ispRoutes: routes.filter((x) => x.id !== r.id) })}
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
          {routes.length === 0 && (
            <tr><td colSpan={3} className="py-3 text-center text-gray-400">No routes: only devices plugged straight into the Internet node, and WAN addresses, can be reached.</td></tr>
          )}
        </tbody>
      </table>
      <div className="border border-gray-100 rounded-lg p-3 space-y-2 bg-gray-50">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add a route</div>
        <input
          data-testid="isp-network"
          className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-300"
          placeholder="Network, e.g. 203.0.113.0/24"
          value={network}
          onChange={(e) => { setNetwork(e.target.value); setError('') }}
        />
        <input
          data-testid="isp-next-hop"
          className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-300"
          placeholder="Next hop: the router's WAN address"
          value={nextHop}
          onChange={(e) => { setNextHop(e.target.value); setError('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
        />
        {error && <p data-testid="isp-error" className="text-xs text-red-600">{error}</p>}
        <button
          data-testid="isp-add"
          onClick={add}
          className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
        >
          <Plus size={12} /> Add route
        </button>
      </div>
    </div>
  )
}

/** On a router's Routing tab: is its LAN announced to the internet (a route in the ISP's table)? */
function InternetAnnouncement({ router }: { router: NetNode }) {
  const { nodes, edges, updateNodeData } = useNetworkStore()
  const a = announcement(router, nodes, edges)
  if (a.state === 'no-address') return null
  const box = (tone: string, children: React.ReactNode) => (
    <div data-testid="announce-status" className={`mb-3 text-xs rounded px-2.5 py-2 border ${tone}`}>{children}</div>
  )
  const btn = (testId: string, label: string, onClick: () => void) => (
    <button data-testid={testId} onClick={onClick}
      className="mt-1.5 text-xs bg-white border border-current px-2 py-0.5 rounded hover:opacity-80 transition-opacity">{label}</button>
  )
  switch (a.state) {
    case 'private':
      return box('bg-gray-50 border-gray-100 text-gray-500',
        <>LAN <span className="font-mono">{a.prefix}</span> is private ({a.range}): every network reuses these addresses, so ISPs never carry them and the internet can't reach this LAN.</>)
    case 'no-internet':
      return box('bg-gray-50 border-gray-100 text-gray-500', <>Not connected to the Internet node.</>)
    case 'announced': {
      const routes = a.cloud.data.ispRoutes
      return box('bg-green-50 border-green-100 text-green-700', <>
        Announced to the internet: the ISP routes <span className="font-mono">{a.prefix}</span> to <span className="font-mono">{a.route?.nextHop ?? a.nextHop}</span>.
        {a.route && Array.isArray(routes) && <div>{btn('withdraw-button', 'Withdraw', () =>
          updateNodeData(a.cloud.id, { ispRoutes: routes.filter((r) => r.id !== a.route!.id) }))}</div>}
      </>)
    }
    case 'not-announced': {
      const routes = a.cloud.data.ispRoutes ?? []
      return box('bg-amber-50 border-amber-100 text-amber-700', <>
        Not announced: the ISP has no route to <span className="font-mono">{a.prefix}</span>, so nothing on the internet can reach this LAN, even with public addresses.
        <div>{btn('announce-button', 'Announce this LAN', () =>
          updateNodeData(a.cloud.id, { ispRoutes: [...routes, { id: `isp${Date.now()}`, ...lanNetwork(router), nextHop: a.nextHop }] }))}</div>
      </>)
    }
    case 'wrong-hop': {
      const routes = a.cloud.data.ispRoutes ?? []
      return box('bg-red-50 border-red-100 text-red-700', <>
        The ISP's route for <span className="font-mono">{routePrefix(a.route!)}</span> points to <span className="font-mono">{nextHopLabel(a.route!.nextHop, nodes)}</span>, not to this router, so traffic for this LAN goes the wrong way.
        <div>{btn('fix-hop-button', `Point it at ${a.nextHop}`, () =>
          updateNodeData(a.cloud.id, { ispRoutes: routes.map((r) => r.id === a.route!.id ? { ...r, nextHop: a.nextHop } : r) }))}</div>
      </>)
    }
  }
}

/**
 * How a host gets its address: typed in by hand, or obtained by DHCP. Choosing DHCP (or Renew) runs the
 * same Discover → Offer → Request → ACK exchange as dhclient, animated, with its capture records.
 */
function IpAssignment({ node }: { node: NetNode }) {
  const { nodes, edges, updateNodeData, dispatchPackets, dispatchCaptures } = useNetworkStore()
  const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'error'; text: string } | null>(null)
  const mode = node.data.ipMode ?? 'manual'

  const request = (fromManual: boolean) => {
    const r = dhcpRequest({
      selfId: node.id, nodes, edges, dispatchPackets, dispatchCaptures, updateNodeData,
      schedule: (ms, fn) => { clock.after(ms, fn) },
    })
    if (!r.ok) {
      // No lease: a device that was set by hand is left without an address (a renewal keeps its old one)
      updateNodeData(node.id, fromManual ? { ipMode: 'dhcp', ip: '', gateway: '' } : { ipMode: 'dhcp' })
      setStatus({ kind: 'error', text: (r.lines[0]?.text ?? '').replace(/^dhclient: /, '') })
      return
    }
    updateNodeData(node.id, { ipMode: 'dhcp' })
    setStatus({ kind: 'busy', text: 'Asking for an address: Discover → Offer → Request → ACK…' })
    const server = r.server!
    clock.after(r.ackMs, () => setStatus({ kind: 'ok', text: `Leased ${r.ip} from ${server.data.label} (${server.data.ip}).` }))
  }

  const choose = (m: 'manual' | 'dhcp') => {
    if (m === mode) return
    if (m === 'manual') { updateNodeData(node.id, { ipMode: 'manual' }); setStatus(null) }
    else request(true)
  }

  const btn = (m: 'manual' | 'dhcp', label: string) => (
    <button
      data-testid={`ip-mode-${m}`}
      aria-pressed={mode === m}
      onClick={() => choose(m)}
      className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${mode === m ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">IP Assignment</label>
      <div className="flex gap-1 bg-gray-100 rounded-md p-0.5">
        {btn('manual', 'Manual (static)')}
        {btn('dhcp', 'Automatic (DHCP)')}
      </div>
      {mode === 'dhcp' && (
        <div className="flex items-start gap-2">
          <p
            data-testid="dhcp-status"
            className={`flex-1 text-xs ${status?.kind === 'error' ? 'text-red-600' : status?.kind === 'ok' ? 'text-green-700' : 'text-gray-400'}`}
          >
            {status?.text ?? 'Address, mask, gateway and DNS server come from the DHCP server. You can still type a different DNS server.'}
          </p>
          <button
            data-testid="dhcp-renew"
            onClick={() => request(false)}
            disabled={status?.kind === 'busy'}
            className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50 px-2 py-1 rounded transition-colors"
          >
            <RotateCcw size={11} /> Renew
          </button>
        </div>
      )}
    </div>
  )
}

export default function ConfigPanel({ nodeId, onClose }: Props) {
  const { nodes, updateNodeData, addRoute, removeRoute, addRule, removeRule } = useNetworkStore()
  const node = nodes.find((n) => n.id === nodeId)
  const [tab, setTab] = useState<'basic' | 'advanced' | 'isp' | 'security' | 'wireless' | 'page' | 'records' | 'files' | 'mailboxes' | 'services' | 'cache'>('basic')

  if (!node) return null

  const { data } = node
  const upd = (patch: Parameters<typeof updateNodeData>[1]) => updateNodeData(nodeId, patch)

  function handleAddRoute() {
    addRoute(nodeId, { destination: '10.0.0.0', subnet: '255.255.255.0', gateway: '0.0.0.0', iface: 'eth0', metric: 1 })
  }

  function handleAddRule() {
    addRule(nodeId, {
      id: `r${Date.now()}`,
      direction: 'in',
      protocol: 'TCP',
      srcIp: '*',
      dstIp: '*',
      port: '80',
      action: 'allow',
    })
  }

  const isRouter = data.deviceType === 'router'
  const isSwitch = data.deviceType === 'switch'
  const isHub = data.deviceType === 'hub'
  const isWap = data.deviceType === 'wap'
  const isFirewall = data.deviceType === 'firewall'
  const isGateway = data.deviceType === 'gateway'
  const isCloud = data.deviceType === 'cloud'
  const isWeb = data.deviceType === 'web'
  const isDns = data.deviceType === 'dns'
  const isFile = data.deviceType === 'file'
  const isMail = data.deviceType === 'mail'
  const hasServices = ['web', 'dns', 'mail', 'file', 'server'].includes(data.deviceType)
  const hasIp = !(isSwitch || isHub)
  const isHost = ['pc', 'laptop', 'server', 'dns', 'web', 'mail', 'file'].includes(data.deviceType)
  const byDhcp = isHost && data.ipMode === 'dhcp'

  const TABS = [
    { id: 'basic',    label: 'Basic' },
    ...(isSwitch ? [{ id: 'advanced', label: 'MAC Table' }] : []),
    ...(isCloud ? [{ id: 'isp', label: 'Routing' }] : []),
    ...((isRouter   || isGateway) ? [{ id: 'advanced', label: 'Routing' }]   : []),
    ...((isWap      || isGateway) ? [{ id: 'wireless', label: 'Wireless' }]  : []),
    ...((isFirewall || isGateway) ? [{ id: 'security', label: 'Security' }]  : []),
    ...(isWeb ? [{ id: 'page',     label: 'Page' }]       : []),
    ...(isDns ? [{ id: 'records',  label: 'Records' }]    : []),
    ...(isFile ? [{ id: 'files',   label: 'Files' }]      : []),
    ...(isMail ? [{ id: 'mailboxes', label: 'Mailboxes' }] : []),
    ...(hasServices ? [{ id: 'services', label: 'Services' }] : []),
    ...(isHost ? [{ id: 'cache', label: 'DNS Cache' }] : []),
  ] as { id: string; label: string }[]

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div>
          <h2 className="font-semibold text-gray-800 text-sm">{data.label}</h2>
          <span className="text-xs text-gray-400 capitalize">{data.deviceType}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              data.isOn ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'
            }`}
            onClick={() => upd({ isOn: !data.isOn })}
          >
            <Power size={11} />
            {data.isOn ? 'Online' : 'Offline'}
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      {TABS.length > 1 && (
        <div className="flex border-b border-gray-200 px-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setTab(t.id as typeof tab)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'basic' && (
          <>
            <Field label="Label" value={data.label} onChange={(v) => upd({ label: v })} />
            {hasIp && (
              <>
                {(isRouter || isGateway) && (
                  <Field label="WAN IP — eth0 (ISP-facing)" value={(data.wanIp as string) ?? ''} onChange={(v) => upd({ wanIp: v })} placeholder="e.g. 82.1.2.3" mono />
                )}
                {isHost && <IpAssignment key={nodeId} node={node} />}
                <Field label={(isRouter || isGateway) ? 'LAN IP — eth1 (network-facing)' : 'IP Address'} value={data.ip} onChange={(v) => upd({ ip: v })} placeholder="192.168.1.x" mono readOnly={byDhcp} testId="ip-address" />
                <Field label="Subnet Mask" value={data.subnet} onChange={(v) => upd({ subnet: v })} placeholder="255.255.255.0" mono readOnly={byDhcp} testId="subnet-mask" />
                <Field label="Default Gateway" value={data.gateway} onChange={(v) => upd({ gateway: v })} placeholder="192.168.1.1" mono readOnly={byDhcp} testId="default-gateway" />
                {isHost && (
                  <>
                    <Field label="DNS Server" value={data.dnsServer ?? ''} onChange={(v) => upd({ dnsServer: v.trim() })} placeholder="e.g. 8.8.8.8" mono />
                    <Field label="Alternate DNS Server" value={data.dnsAlternate ?? ''} onChange={(v) => upd({ dnsAlternate: v.trim() })} placeholder="asked if the first doesn't answer" mono />
                  </>
                )}
                {isDns && (
                  <div className="flex flex-col gap-1">
                    <Field label="Forwarder (upstream DNS)" value={data.dnsForwarder ?? ''} onChange={(v) => upd({ dnsForwarder: v.trim() })} placeholder="blank = no forwarder" mono testId="dns-forwarder" />
                    <p className="text-xs text-gray-400">
                      Names this server doesn't hold are asked here (UDP 53), and the answer is cached for its TTL.
                      Blank: it answers only its own names and refuses the rest (REFUSED).
                    </p>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">MAC Address</label>
                  <span className="font-mono text-sm text-gray-600 bg-gray-50 rounded-md px-2.5 py-1.5 border border-gray-100">
                    {data.mac}
                  </span>
                </div>
              </>
            )}
            {/* DHCP server section — routers and gateways */}
            {(isRouter || isGateway) && (
              <div className="border border-gray-100 rounded-lg p-3 space-y-3 bg-gray-50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-700">DHCP Server</div>
                    <div className="text-xs text-gray-400">Auto-assign IPs to clients</div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={!!data.dhcpEnabled}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                      data.dhcpEnabled ? 'bg-blue-500' : 'bg-gray-300'
                    }`}
                    onClick={() => upd({ dhcpEnabled: !data.dhcpEnabled })}
                    title="Toggle DHCP server"
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                      data.dhcpEnabled ? 'translate-x-4' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
                {data.dhcpEnabled && (
                  <>
                    <Field
                      label="DNS server for clients"
                      value={data.dhcpDns ?? ''}
                      onChange={(v) => upd({ dhcpDns: v.trim() })}
                      placeholder="e.g. 8.8.8.8"
                      mono
                    />
                    <Field
                      label="IP Pool (last octet range)"
                      value={(data.dhcpPool as string) ?? '100-200'}
                      onChange={(v) => upd({ dhcpPool: v })}
                      placeholder="100-200"
                      mono
                    />
                    <p className="text-xs text-gray-400">
                      Clients run <code className="bg-gray-100 px-1 rounded font-mono">dhclient</code> or{' '}
                      <code className="bg-gray-100 px-1 rounded font-mono">ipconfig /renew</code> to get an IP from the pool.
                    </p>
                  </>
                )}
              </div>
            )}
            <Field label="Notes" value={data.notes} onChange={(v) => upd({ notes: v })} placeholder="Add notes..." />
          </>
        )}

        {tab === 'advanced' && (isRouter || isGateway) && (
          <div>
            {(data.wanIp || data.ip) && (
              <div className="mb-3 text-xs text-gray-400 font-mono bg-gray-50 rounded px-2.5 py-2 border border-gray-100">
                eth0 (WAN) = {(data.wanIp as string) || '(not set)'}
                {'  ·  '}
                eth1 (LAN) = {data.ip || '(not set)'}
              </div>
            )}
            <InternetAnnouncement router={node} />
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">Routing Table</h3>
              <button
                className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                onClick={handleAddRoute}
              >
                <Plus size={12} /> Add Route
              </button>
            </div>
            <div className="space-y-2">
              {data.routingTable.map((route, i) => (
                <div key={i} className="bg-gray-50 rounded-lg p-3 text-xs font-mono space-y-1.5 relative">
                  <button
                    className="absolute top-2 right-2 text-gray-300 hover:text-red-400 transition-colors"
                    onClick={() => removeRoute(nodeId, i)}
                  >
                    <Trash2 size={12} />
                  </button>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pr-5">
                    {(['destination', 'subnet', 'gateway', 'iface'] as const).map((field) => (
                      <div key={field}>
                        <div className="text-gray-400 text-xs">{field}</div>
                        <input
                          className="w-full bg-white border border-gray-200 rounded px-1.5 py-0.5 font-mono text-xs"
                          value={route[field]}
                          onChange={(e) => {
                            const updated = data.routingTable.map((r, idx) =>
                              idx === i ? { ...r, [field]: e.target.value } : r
                            )
                            upd({ routingTable: updated })
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {data.routingTable.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">No routes. Add a route above.</p>
              )}
            </div>
          </div>
        )}

        {tab === 'isp' && isCloud && <IspRoutesTab node={node} />}

        {tab === 'advanced' && isSwitch && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">MAC Address Table</h3>
            {data.macTable.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">Table empty. MAC addresses are learnt as traffic flows.</p>
            ) : (
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-100">
                    <th className="text-left py-1">MAC</th>
                    <th className="text-left py-1">Port</th>
                    <th className="text-left py-1">VLAN</th>
                  </tr>
                </thead>
                <tbody>
                  {data.macTable.map((e, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-1 text-blue-600">{e.mac}</td>
                      <td className="py-1">{e.port}</td>
                      <td className="py-1">{e.vlan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'wireless' && (isWap || isGateway) && (
          <>
            <Field label="SSID (Network Name)" value={data.ssid} onChange={(v) => upd({ ssid: v })} />
            <Field label="WPA2 Key" value={data.wpaKey} onChange={(v) => upd({ wpaKey: v })} />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Band</label>
              <div className="flex gap-2">
                {(['2.4GHz', '5GHz'] as const).map((b) => (
                  <button
                    key={b}
                    className={`flex-1 py-1.5 text-sm rounded-md border transition-colors ${
                      data.band === b
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                    onClick={() => upd({ band: b })}
                  >
                    {b}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {data.band === '2.4GHz'
                  ? '2.4 GHz: longer range, slower, more interference'
                  : '5 GHz: shorter range, faster, less congestion'}
              </p>
            </div>
          </>
        )}

        {tab === 'page' && isWeb && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-400">
              Edit the HTML served by this web server. Use{' '}
              <code className="bg-gray-100 px-1 rounded font-mono">curl {data.ip}</code>{' '}
              from a terminal to fetch it.
            </p>
            <textarea
              className="font-mono text-xs bg-gray-900 text-green-400 p-3 rounded-lg resize-none outline-none border border-gray-700 focus:border-green-500 transition-colors"
              style={{ height: '280px' }}
              value={data.pageContent ?? ''}
              onChange={(e) => upd({ pageContent: e.target.value })}
              spellCheck={false}
            />
          </div>
        )}

        {tab === 'records' && isDns && (
          <>
            <SecondaryToggle
              node={node}
              nodes={nodes}
              onChange={(dnsPrimary) => {
                const primary = nodes.find((n) => n.id !== node.id && n.data.deviceType === 'dns' && n.data.ip === dnsPrimary)
                upd(dnsPrimary && primary ? { dnsPrimary, dnsRecords: primary.data.dnsRecords.map((r) => ({ ...r })) } : { dnsPrimary: dnsPrimary ?? '' })
              }}
            />
            {data.dnsPrimary
              ? <RecordsTable records={data.dnsRecords ?? []} />
              : <RecordsTab records={data.dnsRecords ?? []} onChange={(dnsRecords) => upd({ dnsRecords })} />}
          </>
        )}

        {tab === 'cache' && isHost && <DnsCacheTab node={node} />}

        {tab === 'files' && isFile && (
          <FilesTab
            account={data.account ?? DEFAULT_ACCOUNT}
            files={data.files ?? []}
            onAccount={(account) => upd({ account })}
            onFiles={(files) => upd({ files })}
          />
        )}

        {tab === 'services' && hasServices && (
          <div data-testid="services-tab">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Services (listening ports)</h3>
            <p className="text-xs text-gray-400 mb-3">
              Untick a service to stop it: clients then get “connection refused”. Check with{' '}
              <code className="bg-gray-100 px-1 rounded font-mono">ss</code> on this device.
            </p>
            <div className="space-y-1.5">
              {servicesFor(data.deviceType).map((s) => {
                const on = isListening({ ...node, data: { ...data, isOn: true } }, s.id)
                return (
                  <label key={s.id} className="flex items-start gap-2 bg-gray-50 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-gray-100">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={on}
                      onChange={(e) => upd({ services: { ...(data.services ?? {}), [s.id]: e.target.checked } })}
                      data-testid={`service-${s.id}`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800">
                        <span className="font-semibold">{s.protocol}</span>{' '}
                        <span className="font-mono text-xs text-gray-500">{s.transport} {s.port}</span>
                        {s.secure && <span className="ml-1" title="Encrypted">🔒</span>}
                      </div>
                      <div className="text-xs text-gray-500 leading-snug">{s.description}</div>
                    </div>
                  </label>
                )
              })}
            </div>
            {!data.isOn && <p className="text-xs text-red-500 mt-2">This device is offline, so nothing is listening.</p>}

            {(isWeb || isMail) && (
              <div className="mt-4 space-y-2">
                <h3 className="text-sm font-semibold text-gray-700">TLS certificate</h3>
                <select
                  className="w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-300"
                  value={data.certificate ?? 'valid'}
                  onChange={(e) => upd({ certificate: e.target.value as CertificateState })}
                  data-testid="certificate-select"
                >
                  <option value="valid">Valid (issued by Networx Demo CA)</option>
                  <option value="self-signed">Self-signed</option>
                  <option value="expired">Expired</option>
                  <option value="wrong-name">Wrong name (issued to another site)</option>
                </select>
                <p className="text-xs text-gray-400">
                  Used for {isWeb ? 'HTTPS' : 'the --tls ports'}. Clients refuse a certificate that fails the check
                  ({isWeb ? <>try <code className="bg-gray-100 px-1 rounded font-mono">curl -v https://…</code>, then <code className="bg-gray-100 px-1 rounded font-mono">-k</code></> : 'the session stops before the password is sent'}).
                </p>
              </div>
            )}

            {isWeb && (
              <label className="mt-3 flex items-start gap-2 bg-gray-50 rounded-lg px-2.5 py-2 cursor-pointer hover:bg-gray-100">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={!!data.redirectHttp}
                  onChange={(e) => upd({ redirectHttp: e.target.checked })}
                  data-testid="redirect-http"
                />
                <div className="min-w-0">
                  <div className="text-sm text-gray-800 font-semibold">Redirect HTTP to HTTPS</div>
                  <div className="text-xs text-gray-500 leading-snug">
                    Answer every http:// request with <span className="font-mono">301 Moved Permanently</span> pointing at https://.
                    The first request still crosses the network in plain text.
                  </div>
                </div>
              </label>
            )}
          </div>
        )}

        {tab === 'mailboxes' && isMail && (
          <MailboxesTab
            domain={data.mailDomain ?? ''}
            mailboxes={data.mailboxes ?? []}
            onDomain={(mailDomain) => upd({ mailDomain })}
            onMailboxes={(mailboxes) => upd({ mailboxes })}
            onRestore={() => upd({ mailboxes: restoreSampleMail(node) })}
          />
        )}

        {tab === 'security' && (isFirewall || isGateway) && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">Firewall Rules</h3>
              <button
                className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                onClick={handleAddRule}
              >
                <Plus size={12} /> Add Rule
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-1">
              Checked when a connection starts, top to bottom: the first rule that matches wins; no match → allowed.
              Replies to an allowed connection always get through.
            </p>
            <p className="text-xs text-gray-400 mb-3">
              <strong>Inbound</strong> = started from the internet side; <strong>Outbound</strong> = started from this network.
              A denied connection is dropped, so the client times out.
            </p>
            <div className="space-y-2">
              {data.rules.map((rule, idx) => (
                <div
                  key={rule.id}
                  data-testid="firewall-rule"
                  className={`rounded-lg p-3 text-xs space-y-2 relative border ${
                    rule.action === 'allow' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                  }`}
                >
                  <div className="absolute top-2 right-2 flex flex-col items-center gap-0.5">
                    <button
                      className="text-gray-300 hover:text-red-400 transition-colors"
                      onClick={() => removeRule(nodeId, rule.id)}
                      title="Delete rule"
                    >
                      <Trash2 size={12} />
                    </button>
                    <button
                      className="text-gray-400 hover:text-gray-700 disabled:opacity-30 transition-colors"
                      disabled={idx === 0}
                      onClick={() => upd({ rules: moveItem(data.rules, idx, idx - 1) })}
                      title="Move up (checked earlier)"
                      data-testid="rule-up"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      className="text-gray-400 hover:text-gray-700 disabled:opacity-30 transition-colors"
                      disabled={idx === data.rules.length - 1}
                      onClick={() => upd({ rules: moveItem(data.rules, idx, idx + 1) })}
                      title="Move down (checked later)"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>
                  <div className="text-[10px] font-semibold text-gray-500">Rule {idx + 1}</div>
                  <div className="grid grid-cols-3 gap-2 pr-5">
                    {/* Direction */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Direction</div>
                      <select
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs bg-white"
                        value={rule.direction}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, direction: e.target.value as FirewallRule['direction'] } : r
                          )
                          upd({ rules: updated })
                        }}
                      >
                        <option value="in">Inbound</option>
                        <option value="out">Outbound</option>
                      </select>
                    </div>
                    {/* Protocol */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Protocol</div>
                      <select
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs bg-white"
                        value={rule.protocol}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, protocol: e.target.value as FirewallRule['protocol'] } : r
                          )
                          upd({ rules: updated })
                        }}
                      >
                        {['TCP', 'UDP', 'ICMP', 'ANY'].map((p) => <option key={p}>{p}</option>)}
                      </select>
                    </div>
                    {/* Port */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Port</div>
                      <input
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs font-mono bg-white"
                        value={rule.port}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, port: e.target.value } : r
                          )
                          upd({ rules: updated })
                        }}
                        placeholder="80 or *"
                      />
                    </div>
                    {/* Src IP */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Source IP</div>
                      <input
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs font-mono bg-white"
                        value={rule.srcIp}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, srcIp: e.target.value } : r
                          )
                          upd({ rules: updated })
                        }}
                        placeholder="* or IP"
                      />
                    </div>
                    {/* Dst IP */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Dest IP</div>
                      <input
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs font-mono bg-white"
                        value={rule.dstIp}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, dstIp: e.target.value } : r
                          )
                          upd({ rules: updated })
                        }}
                        placeholder="* or IP"
                      />
                    </div>
                    {/* Action */}
                    <div>
                      <div className="text-gray-500 mb-0.5">Action</div>
                      <select
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs bg-white"
                        value={rule.action}
                        onChange={(e) => {
                          const updated = data.rules.map((r) =>
                            r.id === rule.id ? { ...r, action: e.target.value as FirewallRule['action'] } : r
                          )
                          upd({ rules: updated })
                        }}
                      >
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── File server: account and files ───────────────────────────────────────────

function FilesTab({ account, files, onAccount, onFiles }: {
  account: { user: string; password: string }
  files: StoredFile[]
  onAccount: (a: { user: string; password: string }) => void
  onFiles: (f: StoredFile[]) => void
}) {
  return (
    <div className="space-y-4">
      <div className="border border-gray-100 rounded-lg p-3 space-y-2 bg-gray-50">
        <div className="text-sm font-medium text-gray-700">Login account (FTP and SFTP)</div>
        <Field label="Username" value={account.user} onChange={(v) => onAccount({ ...account, user: v })} mono />
        <Field label="Password" value={account.password} onChange={(v) => onAccount({ ...account, password: v })} mono />
        <p className="text-xs text-gray-400">
          Clients “know” this login. With <code className="bg-gray-100 px-1 rounded font-mono">ftp</code> it crosses the
          network readable; with <code className="bg-gray-100 px-1 rounded font-mono">sftp</code> it is encrypted.
        </p>
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-700">Files</h3>
          <button
            className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
            onClick={() => onFiles([...files, { name: `file${files.length + 1}.txt`, content: '' }])}
          >
            <Plus size={12} /> Add File
          </button>
        </div>
        <div className="space-y-2">
          {files.map((f, i) => (
            <div key={i} className="bg-gray-50 rounded-lg p-2 space-y-1.5 relative">
              <button
                className="absolute top-2 right-2 text-gray-300 hover:text-red-400 transition-colors"
                onClick={() => onFiles(files.filter((_, j) => j !== i))}
                title="Remove file"
              >
                <Trash2 size={12} />
              </button>
              <input
                className="w-[85%] font-mono text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
                value={f.name}
                onChange={(e) => onFiles(files.map((g, j) => (j === i ? { ...g, name: e.target.value } : g)))}
              />
              <textarea
                className="w-full font-mono text-[11px] border border-gray-200 rounded px-1.5 py-1 bg-white resize-y"
                rows={4}
                value={f.content}
                onChange={(e) => onFiles(files.map((g, j) => (j === i ? { ...g, content: e.target.value } : g)))}
                spellCheck={false}
              />
            </div>
          ))}
          {files.length === 0 && <p className="text-xs text-gray-400 text-center py-4">No files.</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Mail server: mailboxes ───────────────────────────────────────────────────

/** The sample mailboxes for this server: from the preset it came from, else the defaults. */
function sampleMailboxes(node: NetNode): Mailbox[] {
  const fromPreset = PRESETS.flatMap((p) => p.nodes).find(
    (n) => n.data.deviceType === 'mail' && (n.id === node.id || (!!n.data.mailDomain && n.data.mailDomain === node.data.mailDomain)),
  )
  return structuredClone(fromPreset?.data.mailboxes ?? defaultMailboxes())
}

/** Put the sample messages back (needed to re-run the POP3 demo). Other mailboxes are left alone. */
function restoreSampleMail(node: NetNode): Mailbox[] {
  const samples = sampleMailboxes(node)
  const current = node.data.mailboxes ?? []
  const restored = current.map((b) => {
    const sample = samples.find((s) => s.address.toLowerCase() === b.address.toLowerCase())
    return sample ? { ...b, messages: sample.messages } : b
  })
  const missing = samples.filter((s) => !current.some((b) => b.address.toLowerCase() === s.address.toLowerCase()))
  return [...restored, ...missing]
}

function MailboxesTab({ domain, mailboxes, onDomain, onMailboxes, onRestore }: {
  domain: string
  mailboxes: Mailbox[]
  onDomain: (d: string) => void
  onMailboxes: (m: Mailbox[]) => void
  onRestore: () => void
}) {
  const [open, setOpen] = useState<number | null>(0)
  const update = (i: number, patch: Partial<Mailbox>) => onMailboxes(mailboxes.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  return (
    <div className="space-y-3">
      <Field label="Mail domain" value={domain} onChange={onDomain} placeholder="careconnect.example" mono />
      <p className="text-xs text-gray-400">
        Clients find this server as <code className="bg-gray-100 px-1 rounded font-mono">mail.{domain || '<domain>'}</code>: it needs a DNS A record.
      </p>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Mailboxes</h3>
        <div className="flex gap-1.5">
          <button
            className="flex items-center gap-1 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 px-2 py-1 rounded transition-colors"
            onClick={onRestore}
            title="Put the sample messages back, e.g. after a POP3 demo emptied the mailbox"
            data-testid="restore-mail"
          >
            <RotateCcw size={12} /> Restore sample mail
          </button>
          <button
            className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
            onClick={() => onMailboxes([...mailboxes, { address: `user${mailboxes.length + 1}@${domain || 'example.local'}`, password: 'password123', messages: [] }])}
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {mailboxes.map((b, i) => (
          <div key={i} className="bg-gray-50 rounded-lg p-2 relative" data-testid="mailbox">
            <button
              className="absolute top-2 right-2 text-gray-300 hover:text-red-400 transition-colors"
              onClick={() => onMailboxes(mailboxes.filter((_, j) => j !== i))}
              title="Remove mailbox"
            >
              <Trash2 size={12} />
            </button>
            <input
              className="w-[85%] font-mono text-xs border border-gray-200 rounded px-1.5 py-0.5 mb-1 bg-white"
              value={b.address}
              onChange={(e) => update(i, { address: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <input
                className="flex-1 font-mono text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
                value={b.password}
                onChange={(e) => update(i, { password: e.target.value })}
                title="Password"
              />
              <button
                className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                onClick={() => setOpen(open === i ? null : i)}
                data-testid="mailbox-count"
              >
                {b.messages.length} message{b.messages.length === 1 ? '' : 's'}
              </button>
            </div>
            {open === i && b.messages.length > 0 && (
              <table className="w-full text-[11px] mt-1.5">
                <thead>
                  <tr className="text-gray-400"><th className="text-left font-medium">From</th><th className="text-left font-medium">Subject</th><th className="font-medium">Seen</th></tr>
                </thead>
                <tbody>
                  {b.messages.map((m) => (
                    <tr key={m.id} className="border-t border-gray-100">
                      <td className="py-0.5 pr-1 truncate max-w-[90px] font-mono">{m.from}</td>
                      <td className="py-0.5 pr-1">{m.subject}</td>
                      <td className="py-0.5 text-center">{m.seen ? '✓' : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        {mailboxes.length === 0 && <p className="text-xs text-gray-400 text-center py-4">No mailboxes.</p>}
      </div>
    </div>
  )
}

// ─── DNS server: records ──────────────────────────────────────────────────────

/** A host name that may wrap after each dot (never in the middle of a label). */
function DottedName({ name }: { name: string }) {
  const parts = name.split('.')
  return <>{parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 ? '.' : ''}{i < parts.length - 1 && <wbr />}</span>)}</>
}

const VALUE_PLACEHOLDER: Record<DnsRecordType, string> = {
  A: '203.0.113.80',
  AAAA: '2001:db8::80',
  CNAME: 'careconnect.example',
  MX: 'mail.careconnect.example',
  NS: 'ns1.careconnect.example',
  TXT: '"v=spf1 mx -all"',
}

/** Name · Type · Value · TTL (and Priority for MX). A record is only saved when it is valid. */
function RecordsTab({ records, onChange }: { records: DnsRecord[]; onChange: (r: DnsRecord[]) => void }) {
  const blank = { name: '', type: 'A' as DnsRecordType, value: '', ttl: String(DEFAULT_TTL), priority: '10' }
  const [draft, setDraft] = useState(blank)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setDraft(blank)
    setEditing(null)
    setError(null)
  }

  function save() {
    const ttl = draft.ttl.trim() === '' ? NaN : Number(draft.ttl)
    const rec: DnsRecord = {
      id: editing ?? `dr${Date.now()}`,
      name: draft.name.trim(),
      type: draft.type,
      value: draft.value.trim(),
      ttl,
      ...(draft.type === 'MX' ? { priority: draft.priority.trim() === '' ? NaN : Number(draft.priority) } : {}),
    }
    const problem = validateRecord(rec, records)
    if (problem) {
      setError(problem)
      return
    }
    onChange(editing ? records.map((r) => (r.id === editing ? rec : r)) : [...records, rec])
    reset()
  }

  function edit(r: DnsRecord) {
    setDraft({ name: r.name, type: r.type, value: r.value, ttl: String(r.ttl), priority: String(r.priority ?? 10) })
    setEditing(r.id)
    setError(null)
  }

  const input = 'w-full border border-gray-200 rounded px-1.5 py-1 text-xs font-mono bg-white outline-none focus:ring-2 focus:ring-blue-300'
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-700">DNS Records</h3>
        <p className="text-xs text-gray-400">
          The records this server holds (it is authoritative for them). Try{' '}
          <code className="bg-gray-100 px-1 rounded font-mono">dig</code> or{' '}
          <code className="bg-gray-100 px-1 rounded font-mono">nslookup</code> from any device.
        </p>
      </div>

      <div className="border border-gray-100 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="text-left font-semibold px-2 py-1">Name</th>
              <th className="text-left font-semibold px-1 py-1">Type</th>
              <th className="text-left font-semibold px-1 py-1">Value</th>
              <th className="text-right font-semibold px-1 py-1">TTL</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} data-testid="dns-record-row" className={`border-t border-gray-100 ${editing === r.id ? 'bg-blue-50' : ''}`}>
                <td className="px-2 py-1 font-mono"><DottedName name={r.name} /></td>
                <td className="px-1 py-1 font-mono font-semibold text-gray-600">{r.type}</td>
                <td className="px-1 py-1 font-mono [overflow-wrap:anywhere]" title={rdata(r)}>{r.type === 'MX' && `${r.priority ?? 10} `}<DottedName name={r.value} /></td>
                <td className="px-1 py-1 font-mono text-right">{r.ttl}</td>
                <td className="px-1 py-1">
                  <div className="flex items-center justify-end gap-1">
                    <button className="text-gray-300 hover:text-blue-500" onClick={() => edit(r)} title="Edit" data-testid="dns-edit">
                      <Pencil size={11} />
                    </button>
                    <button
                      className="text-gray-300 hover:text-red-400"
                      onClick={() => { onChange(records.filter((x) => x.id !== r.id)); if (editing === r.id) reset() }}
                      title="Delete"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td colSpan={5} className="text-center text-gray-400 py-3">No records yet. Add one below.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border border-gray-100 rounded-lg p-3 space-y-2 bg-gray-50">
        <div className="text-xs font-semibold text-gray-600">{editing ? 'Edit record' : 'Add a record'}</div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input className={input} placeholder="portal.careconnect.example" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="dns-name" aria-label="Name" />
          <select className={input} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as DnsRecordType })} data-testid="dns-type" aria-label="Type">
            {RECORD_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <p className="text-[11px] text-gray-500">{RECORD_HELP[draft.type]}</p>
        <input className={input} placeholder={VALUE_PLACEHOLDER[draft.type]} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} data-testid="dns-value" aria-label="Value" />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-gray-500">TTL (seconds)
            <input className={input} value={draft.ttl} onChange={(e) => setDraft({ ...draft, ttl: e.target.value })} data-testid="dns-ttl" />
          </label>
          {draft.type === 'MX' && (
            <label className="text-[11px] text-gray-500">Priority
              <input className={input} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} data-testid="dns-priority" />
            </label>
          )}
        </div>
        {error && <p className="text-xs text-red-600" data-testid="dns-error">{error}</p>}
        <div className="flex gap-2">
          <button className="flex items-center gap-1 text-xs bg-blue-600 text-white hover:bg-blue-700 px-2.5 py-1 rounded" onClick={save} data-testid="dns-save">
            {editing ? 'Save' : <><Plus size={12} /> Add record</>}
          </button>
          {editing && (
            <button className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1" onClick={reset}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A DNS server can be a secondary: it copies another server's records (read-only here). */
function SecondaryToggle({ node, nodes, onChange }: { node: NetNode; nodes: NetNode[]; onChange: (primaryIp: string | null) => void }) {
  const others = nodes.filter((n) => n.id !== node.id && n.data.deviceType === 'dns' && n.data.ip)
  const on = !!node.data.dnsPrimary
  const [ip, setIp] = useState(node.data.dnsPrimary || others[0]?.data.ip || '')
  const primary = others.find((n) => n.data.ip === node.data.dnsPrimary)
  return (
    <div className="border border-gray-100 rounded-lg p-3 mb-3 bg-gray-50 space-y-2">
      <label className="flex items-center gap-2 text-xs font-medium text-gray-700">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? ip : null)} data-testid="dns-secondary" />
        Copy records from (primary):
        <input
          className="w-32 border border-gray-200 rounded px-1.5 py-0.5 text-xs font-mono bg-white"
          value={on ? node.data.dnsPrimary : ip}
          onChange={(e) => { setIp(e.target.value.trim()); if (on) onChange(e.target.value.trim()) }}
          placeholder="203.0.113.53"
          data-testid="dns-primary-ip"
        />
      </label>
      {on && (
        <p className="text-[11px] text-gray-500">
          {primary
            ? `A secondary: it copies ${primary.data.label}'s records while both are online, and keeps answering with its copy if the primary goes offline.`
            : 'No DNS server has that address yet.'}
        </p>
      )}
    </div>
  )
}

/** The records, read-only (a secondary's copy). */
/** Re-render when a DNS cache changes, and every second so the TTLs count down (they stop while step mode pauses). */
function useDnsCacheTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const off = subscribeDnsCache(bump)
    const timer = setInterval(bump, 1000)
    return () => { off(); clearInterval(timer) }
  }, [])
}

function CacheTable({ cacheId, testId, empty }: { cacheId: string; testId: string; empty: string }) {
  const entries = cacheArrived(cacheId)
  if (!entries.length) return <p data-testid={`${testId}-empty`} className="text-xs text-gray-400 text-center py-3">{empty}</p>
  return (
    <div data-testid={testId} className="border border-gray-100 rounded-lg overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="text-left font-semibold px-2 py-1">Name</th>
            <th className="text-left font-semibold px-1 py-1">Type</th>
            <th className="text-left font-semibold px-1 py-1">Answer</th>
            <th className="text-right font-semibold px-2 py-1 whitespace-nowrap" title="Seconds until the answer expires">TTL left</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.name}|${e.qtype}`} data-testid="dns-cache-row" className="border-t border-gray-100 align-top">
              <td className="px-2 py-1 font-mono">
                <DottedName name={e.name} />
                <div className="text-gray-400 font-sans">from {e.serverIp}</div>
              </td>
              <td className="px-1 py-1 font-mono font-semibold text-gray-600">{e.qtype}</td>
              <td className="px-1 py-1 font-mono [overflow-wrap:anywhere]">
                {e.answer.status !== 'NOERROR'
                  ? <span className="text-red-600">{e.answer.status === 'NXDOMAIN' ? 'no such name' : e.answer.status}</span>
                  : e.answer.records.length
                    ? e.answer.records.map((r, i) => <div key={i}><DottedName name={rdata(r)} />{r.type !== e.qtype && <span className="text-gray-400"> ({r.type})</span>}</div>)
                    : <span className="text-gray-400 font-sans">no record of this type</span>}
              </td>
              <td className="px-2 py-1 font-mono text-right whitespace-nowrap">{e.remaining} s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * What this device has cached from DNS (the same as dnscache in its terminal). A DNS server also lists the
 * answers it got from its forwarder, which it uses to answer other devices.
 */
function DnsCacheTab({ node }: { node: NetNode }) {
  useDnsCacheTick()
  const isServer = node.data.deviceType === 'dns'
  const flush = () => {
    flushDnsCache(node.id)
    if (isServer) flushDnsCache(serverCacheId(node.id))
  }
  return (
    <div className="space-y-4">
      {isServer && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">Answers from its forwarder</h3>
          <p className="text-xs text-gray-400">
            Names this server doesn't hold, asked of its forwarder{node.data.dnsForwarder ? <> (<span className="font-mono">{node.data.dnsForwarder}</span>)</> : ''}.
            Until the TTL runs out, it answers other devices from here without asking again.
          </p>
          <CacheTable cacheId={serverCacheId(node.id)} testId="dns-server-cache" empty="Nothing cached yet. Look up a name this server doesn't hold from a device that uses it." />
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700">{isServer ? 'Its own lookups' : 'DNS cache'}</h3>
        <p className="text-xs text-gray-400">
          {isServer
            ? "Names looked up by commands run in this server's terminal."
            : 'Names this device has looked up. It uses an answer until the TTL runs out, then asks its DNS server again. (nslookup and dig ask the DNS server directly, so they don\'t add to it.)'}
        </p>
        <CacheTable cacheId={node.id} testId="dns-cache" empty={`Empty. Try ping or curl with a name in ${node.data.label}'s terminal.`} />
      </div>
      <button
        data-testid="dns-cache-flush"
        onClick={flush}
        className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
      >
        <Trash2 size={11} /> Flush (same as flushdns)
      </button>
    </div>
  )
}

function RecordsTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="text-left font-semibold px-2 py-1">Name</th>
            <th className="text-left font-semibold px-1 py-1">Type</th>
            <th className="text-left font-semibold px-1 py-1">Value</th>
            <th className="text-right font-semibold px-2 py-1">TTL</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} data-testid="dns-record-row" className="border-t border-gray-100">
              <td className="px-2 py-1 font-mono"><DottedName name={r.name} /></td>
              <td className="px-1 py-1 font-mono font-semibold text-gray-600">{r.type}</td>
              <td className="px-1 py-1 font-mono [overflow-wrap:anywhere]">{r.type === 'MX' && `${r.priority ?? 10} `}<DottedName name={r.value} /></td>
              <td className="px-2 py-1 font-mono text-right">{r.ttl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
