import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Eye, EyeOff, Trash2, Search } from 'lucide-react'
import { useNetworkStore } from '../store'
import type { CaptureRecord } from '../types'
import { cipherHex, cipherLength } from '../simulation/exchange'
import { protocolTint, PROTOCOL_COLORS } from './protocolColors'

const FILTERS = ['All', 'DNS', 'DHCP', 'TCP', 'HTTP', 'TLS', 'FTP', 'SSH', 'SMTP', 'POP3', 'IMAP', 'ICMP', 'ARP'] as const
type Filter = typeof FILTERS[number]

/** Teacher-only plaintext reveal: present only with ?teacher=1 in the URL. */
const TEACHER = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('teacher') === '1'

/** The Protocol column: the application protocol if any, else the transport. */
export function protocolOf(r: CaptureRecord): string {
  return r.app ?? r.transport
}

function matchesFilter(r: CaptureRecord, f: Filter): boolean {
  switch (f) {
    case 'All': return true
    case 'TCP': return r.transport === 'TCP'
    case 'FTP': return r.app === 'FTP' || r.app === 'FTP-DATA'
    default:    return r.app === f
  }
}

/** Search only what the capture shows: an encrypted payload is searched as its ciphertext. */
function searchableText(r: CaptureRecord): string {
  const visible = r.encrypted ? cipherHex(r.conversationId, r.stepIndex, r.app === 'TLS') : (r.payload ?? '')
  return [r.info, visible, r.cleartext ?? '', endpoint(r.srcIp, r.srcPort), endpoint(r.dstIp, r.dstPort), protocolOf(r)]
    .join('\n').toLowerCase()
}

function endpoint(ip: string, port?: number): string {
  return port === undefined ? ip : `${ip}:${port}`
}

export default function CaptureDrawer() {
  const { captures, clearCaptures, setCaptureOpen } = useNetworkStore()
  const [height, setHeight] = useState(260)
  const [filter, setFilter] = useState<Filter>('All')
  const [query, setQuery] = useState('')
  const [selectedNo, setSelectedNo] = useState<number | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return captures.filter((r) => matchesFilter(r, filter) && (!q || searchableText(r).includes(q)))
  }, [captures, filter, query])

  const selected = selectedNo === null ? null : captures.find((r) => r.no === selectedNo) ?? null

  // Keep the selected row in view when the detail pane opens beneath it
  useEffect(() => {
    if (selectedNo === null) return
    const t = setTimeout(() => {
      tableRef.current?.querySelector(`[data-no="${selectedNo}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => clearTimeout(t)
  }, [selectedNo])

  // Follow new packets unless the user has scrolled up to look at older ones
  useEffect(() => {
    const el = tableRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [rows.length])

  function onScroll() {
    const el = tableRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const move = (ev: MouseEvent) => {
      const max = window.innerHeight - 160
      setHeight(Math.min(max, Math.max(140, startH + (startY - ev.clientY))))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <section
      className="flex flex-col bg-white border-t border-gray-300 flex-shrink-0 relative"
      style={{ height }}
      data-testid="capture-drawer"
    >
      {/* Resize handle */}
      <div
        className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10 hover:bg-blue-200/60"
        onMouseDown={startResize}
        title="Drag to resize"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <span className="text-sm font-semibold text-gray-700">Packet capture</span>
        <span className="text-xs text-gray-400 tabular-nums" data-testid="capture-count">
          {rows.length === captures.length ? `${captures.length} packets` : `${rows.length} of ${captures.length} packets`}
        </span>
        <button
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 px-1.5 py-0.5 rounded hover:bg-red-50"
          onClick={() => { clearCaptures(); setSelectedNo(null) }}
          title="Clear the capture"
        >
          <Trash2 size={12} /> Clear
        </button>
        <select
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label="Protocol filter"
          data-testid="capture-filter"
        >
          {FILTERS.map((f) => <option key={f}>{f}</option>)}
        </select>
        <div className="flex items-center gap-1 border border-gray-200 rounded px-1.5 py-0.5 bg-white">
          <Search size={11} className="text-gray-400" />
          <input
            className="text-xs outline-none w-36"
            placeholder="Search info / payload"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="capture-search"
          />
        </div>
        <button
          className="ml-auto text-gray-400 hover:text-gray-600"
          onClick={() => setCaptureOpen(false)}
          title="Close the capture"
        >
          <X size={14} />
        </button>
      </div>
      <p className="px-3 py-0.5 text-[11px] text-gray-400 border-b border-gray-100 flex-shrink-0">
        Shows every packet in this network. A real attacker only sees the link they can tap.
      </p>

      {/* Table */}
      <div ref={tableRef} onScroll={onScroll} className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-xs font-mono border-collapse" data-testid="capture-table">
          <thead className="sticky top-0 bg-gray-100 text-gray-600 z-[1]">
            <tr>
              {['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Length', 'Info'].map((h) => (
                <th key={h} className="text-left font-semibold px-2 py-1 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const proto = protocolOf(r)
              const isSel = r.no === selectedNo
              return (
                <tr
                  key={r.no}
                  data-no={r.no}
                  className={`cursor-pointer border-b border-white ${isSel ? 'outline outline-2 outline-blue-500 -outline-offset-2' : ''}`}
                  style={{ background: isSel ? '#dbeafe' : protocolTint(proto) }}
                  onClick={() => setSelectedNo(isSel ? null : r.no)}
                >
                  <td className="px-2 py-0.5 text-gray-500 tabular-nums">{r.no}</td>
                  <td className="px-2 py-0.5 text-gray-500 tabular-nums">{(r.timeMs / 1000).toFixed(3)}</td>
                  <td className="px-2 py-0.5 whitespace-nowrap">{endpoint(r.srcIp, r.srcPort)}</td>
                  <td className="px-2 py-0.5 whitespace-nowrap">{endpoint(r.dstIp, r.dstPort)}</td>
                  <td className="px-2 py-0.5 font-semibold" style={{ color: PROTOCOL_COLORS[proto] ?? '#374151' }}>{proto}</td>
                  <td className="px-2 py-0.5 tabular-nums">{r.length}</td>
                  <td className="px-2 py-0.5 whitespace-nowrap">{r.info}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400 font-sans">
                {captures.length === 0
                  ? 'No packets yet. Run a command in a terminal (try nslookup or curl) and watch them arrive.'
                  : 'No packets match the filter.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <CaptureDetail record={selected} />}
    </section>
  )
}

// ─── Detail pane ──────────────────────────────────────────────────────────────

function LayerRow({ name, osi, children }: { name: string; osi: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-2 py-1 border-b border-gray-100 last:border-0">
      <div className="text-gray-500">
        <span className="font-semibold text-gray-700">{name}</span> <span className="text-[10px]">(OSI {osi})</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function CaptureDetail({ record: r }: { record: CaptureRecord }) {
  const [reveal, setReveal] = useState(false)
  useEffect(() => setReveal(false), [r.no])
  const proto = protocolOf(r)
  const firstLine = (r.payload ?? '').split('\n')[0]

  return (
    <div className="max-h-[55%] overflow-auto border-t-2 border-gray-200 bg-gray-50 px-3 py-1.5 text-xs flex-shrink-0" data-testid="capture-detail">
      {r.transport !== 'ARP' && r.transport !== 'ICMP' && (
        <LayerRow name="Application" osi="5–7">
          {r.app === null ? (
            <span className="text-gray-400">— none: a TCP control segment ({r.tcpFlags}) carries no application data</span>
          ) : r.encrypted ? (
            <>
              <div className="font-semibold">
                🔒 {r.app} — {r.app === 'TLS' ? 'Application Data' : 'Encrypted packet'} (encrypted, {cipherLength(r.payload ?? '')} bytes)
              </div>
              {r.cleartext && <pre className="font-mono whitespace-pre-wrap text-gray-800 mt-0.5">{r.cleartext}</pre>}
              <pre className="font-mono whitespace-pre-wrap text-gray-500 mt-0.5" data-testid="ciphertext">
                {cipherHex(r.conversationId, r.stepIndex, r.app === 'TLS')}
              </pre>
              <p className="text-gray-500 mt-0.5">
                The content is unreadable without the session key. Still visible: IP addresses, ports, size, timing.
              </p>
              {TEACHER && (
                <div className="mt-1">
                  <button
                    className="flex items-center gap-1 text-[11px] text-indigo-600 hover:underline"
                    onClick={() => setReveal((v) => !v)}
                  >
                    {reveal ? <EyeOff size={12} /> : <Eye size={12} />} Teacher view
                  </button>
                  {reveal && (
                    <div className="mt-1 border border-indigo-200 bg-indigo-50 rounded p-1.5">
                      <div className="text-[11px] text-indigo-700 font-semibold">What the endpoints see after decryption</div>
                      <pre className="font-mono whitespace-pre-wrap text-gray-800">{r.payload}</pre>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="font-semibold">{proto} — {firstLine || r.info}</div>
              {r.payload && <pre className="font-mono whitespace-pre-wrap text-gray-800 mt-0.5" data-testid="payload">{r.payload}</pre>}
            </>
          )}
          {r.note && <p className="text-gray-600 mt-0.5 font-mono whitespace-pre-wrap">{r.note}</p>}
        </LayerRow>
      )}
      {r.transport !== 'ARP' && r.transport !== 'ICMP' && (
        <LayerRow name="Transport" osi="4">
          <span className="font-mono">
            {r.transport}  src port {r.srcPort} → dst port {r.dstPort}
            {r.tcpFlags ? `   flags: ${r.tcpFlags}` : r.transport === 'UDP' ? '   (no handshake)' : ''}
          </span>
        </LayerRow>
      )}
      {r.transport !== 'ARP' && (
        <LayerRow name="Internet" osi="3">
          <span className="font-mono">IPv4 src {r.srcIp} → dst {r.dstIp}   TTL 64</span>
          {r.transport === 'ICMP' && <div className="font-mono">ICMP {r.info}</div>}
        </LayerRow>
      )}
      <LayerRow name="Link" osi="1–2">
        <span className="font-mono">Ethernet/Wi-Fi  src {r.srcMac} → dst {r.dstMac}  (first hop)</span>
        {r.transport === 'ARP' && <div className="font-mono">ARP {r.info}</div>}
      </LayerRow>
    </div>
  )
}
