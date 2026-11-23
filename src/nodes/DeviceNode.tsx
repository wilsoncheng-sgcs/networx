import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NetNode } from '../types'
import { useNetworkStore } from '../store'
import {
  Monitor, Server, Router, Zap, Wifi, Shield, Globe,
  Laptop, HardDrive, Settings, Terminal as TermIcon, Cloud, Home, Mail, FolderOpen,
} from 'lucide-react'

const DEVICE_CONFIG = {
  pc:       { icon: Monitor,   color: '#2563eb', bg: '#dbeafe', label: 'PC' },
  laptop:   { icon: Laptop,    color: '#7c3aed', bg: '#ede9fe', label: 'Laptop' },
  server:   { icon: Server,    color: '#059669', bg: '#d1fae5', label: 'Server' },
  router:   { icon: Router,    color: '#dc2626', bg: '#fee2e2', label: 'Router' },
  switch:   { icon: HardDrive, color: '#d97706', bg: '#fef3c7', label: 'Switch' },
  hub:      { icon: Zap,       color: '#6b7280', bg: '#f3f4f6', label: 'Hub' },
  wap:      { icon: Wifi,      color: '#0891b2', bg: '#cffafe', label: 'Access Point' },
  firewall: { icon: Shield,    color: '#9333ea', bg: '#f3e8ff', label: 'Firewall' },
  gateway:  { icon: Home,      color: '#0f766e', bg: '#ccfbf1', label: 'Home Gateway' },
  dns:      { icon: Globe,     color: '#0284c7', bg: '#e0f2fe', label: 'DNS' },
  web:      { icon: Globe,     color: '#16a34a', bg: '#dcfce7', label: 'Web Server' },
  cloud:    { icon: Cloud,     color: '#0369a1', bg: '#f0f9ff', label: 'Internet' },
  mail:     { icon: Mail,      color: '#be185d', bg: '#fce7f3', label: 'Mail Server' },
  file:     { icon: FolderOpen, color: '#a16207', bg: '#fef9c3', label: 'File Server' },
} as const

export type DeviceType = keyof typeof DEVICE_CONFIG

/** Device types that have a Terminal tab. */
export const TERMINAL_TYPES: string[] = ['pc', 'laptop', 'server', 'dns', 'web', 'mail', 'file']

const HANDLE_STYLE = {
  width: 10,
  height: 10,
  background: '#6b7280',
  border: '2px solid #d1d5db',
}

/**
 * The TCP/IP layer a device works up to, by name (spec §7.5). Names, not numbers, so they don't clash
 * with OSI numbering (OSI Layer 7 = Application); the tooltip gives the OSI equivalent.
 */
const APPLICATION = { label: 'Application', osi: 'TCP/IP Application layer = OSI layers 5–7', color: '#1d4ed8', bg: '#dbeafe' }
const LINK = { label: 'Link', osi: 'TCP/IP Link layer = OSI layers 1–2', color: '#d97706', bg: '#fef3c7' }
const LAYER_INFO: Record<string, { label: string; osi: string; color: string; bg: string }> = {
  pc:       APPLICATION,
  laptop:   APPLICATION,
  server:   APPLICATION,
  dns:      APPLICATION,
  web:      APPLICATION,
  mail:     APPLICATION,
  file:     APPLICATION,
  router:   { label: 'Internet',           osi: 'TCP/IP Internet layer = OSI layer 3', color: '#dc2626', bg: '#fee2e2' },
  firewall: { label: 'Internet–Transport', osi: 'TCP/IP Internet and Transport layers = OSI layers 3–4 (filters by IP address and port)', color: '#dc2626', bg: '#fee2e2' },
  gateway:  { label: 'Link–Internet',      osi: 'TCP/IP Link and Internet layers = OSI layers 1–3 (switch, Wi-Fi and router in one box)', color: '#0f766e', bg: '#ccfbf1' },
  wap:      LINK,
  switch:   LINK,
  hub:      { ...LINK, color: '#6b7280', bg: '#f3f4f6' },
  cloud:    { label: 'Internet',           osi: 'TCP/IP Internet layer = OSI layer 3', color: '#0369a1', bg: '#e0f2fe' },
}

export default function DeviceNode({ id, data, selected }: NodeProps<NetNode>) {
  const { setPanel, selectNode, showLayers } = useNetworkStore()
  const cfg = DEVICE_CONFIG[data.deviceType] ?? DEVICE_CONFIG.pc
  const Icon = cfg.icon
  const hasTerminal = TERMINAL_TYPES.includes(data.deviceType)
  const isCloud = data.deviceType === 'cloud'

  function openConfig() {
    selectNode(id)
    setPanel('config')
  }

  function openTerminal() {
    selectNode(id)
    setPanel('terminal')
  }

  return (
    <div className="relative flex flex-col items-center" style={{ minWidth: isCloud ? 110 : 90 }}>
      {/* Handles – all 4 sides */}
      <Handle type="target" position={Position.Top}    id="t"  style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Top}    id="st" style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Left}   id="l"  style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Left}   id="sl" style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Right}  id="r"  style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right}  id="sr" style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Bottom} id="b"  style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="sb" style={HANDLE_STYLE} />

      {/* Device body */}
      <div
        className="rounded-xl shadow-md flex flex-col items-center px-3 py-2 gap-1 cursor-pointer transition-all"
        style={{
          background: isCloud
            ? 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)'
            : cfg.bg,
          border: selected
            ? `2px solid ${cfg.color}`
            : isCloud ? '2px dashed #7dd3fc' : '2px solid transparent',
          outline: selected ? `3px solid ${cfg.color}33` : 'none',
          opacity: data.isOn ? 1 : 0.5,
        }}
        onClick={openConfig}
      >
        {/* Power / status indicator — cloud always shows as "connected" */}
        {!isCloud && (
          <div className="absolute top-1 right-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: data.isOn ? '#22c55e' : '#ef4444' }}
              title={data.isOn ? 'Online' : 'Offline'}
            />
          </div>
        )}

        <Icon size={isCloud ? 36 : 32} color={cfg.color} strokeWidth={1.5} />

        <span
          className="text-xs font-semibold text-center leading-tight"
          style={{ color: cfg.color, maxWidth: 90 }}
        >
          {data.label}
        </span>

        {isCloud ? (
          <span className="text-xs text-sky-400 font-mono">WAN / ISP</span>
        ) : (data.deviceType === 'router' || data.deviceType === 'gateway') && data.wanIp ? (
          <>
            <span className="text-xs text-gray-500 font-mono">LAN: {data.ip}</span>
            <span className="text-xs text-orange-500 font-mono">WAN: {data.wanIp}</span>
          </>
        ) : (
          data.ip && <span className="text-xs text-gray-500 font-mono">{data.ip}</span>
        )}

        {/* TCP/IP layer badge */}
        {showLayers && (() => {
          const l = LAYER_INFO[data.deviceType]
          return l ? (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none cursor-help"
              style={{ background: l.bg, color: l.color, border: `1px solid ${l.color}44` }}
              title={l.osi}
              data-testid="layer-label">
              {l.label}
            </span>
          ) : null
        })()}

        {/* Action buttons */}
        {!isCloud && (
          <div className="flex gap-1 mt-0.5">
            <button
              className="p-0.5 rounded hover:bg-white/60 transition-colors"
              title="Configure"
              onClick={(e) => { e.stopPropagation(); openConfig() }}
            >
              <Settings size={12} color={cfg.color} />
            </button>
            {hasTerminal && (
              <button
                className="p-0.5 rounded hover:bg-white/60 transition-colors"
                title="Terminal"
                onClick={(e) => { e.stopPropagation(); openTerminal() }}
              >
                <TermIcon size={12} color={cfg.color} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
