import { useEffect, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useNetworkStore } from '../store'
import type { PacketAnim } from '../types'
import { PROTOCOL_COLORS } from '../components/protocolColors'


// Separate component so useEffect fires correctly on mount
function PacketDot({ edgePath, packet }: { edgePath: string; packet: PacketAnim }) {
  const ref = useRef<SVGAnimationElement>(null)
  const color = PROTOCOL_COLORS[packet.protocol] ?? '#6b7280'
  const [landed, setLanded] = useState(false)

  useEffect(() => {
    // begin="indefinite" means the animation only starts when beginElement() is called.
    // Calling it here (on mount) starts it immediately — avoids the SVG SMIL "document
    // time 0" problem where begin="0ms" fires in the past and jumps to fill="freeze".
    ref.current?.beginElement()
    // A dropped packet shows its ✕ once it reaches the firewall
    if (!packet.dropped) return
    const t = setTimeout(() => setLanded(true), packet.durationMs)
    return () => clearTimeout(t)
  }, [packet.dropped, packet.durationMs])

  return (
    <g>
      <animateMotion
        ref={ref as React.RefObject<SVGAnimateMotionElement>}
        path={edgePath}
        dur={`${packet.durationMs}ms`}
        begin="indefinite"
        fill="freeze"
        repeatCount="1"
        {...(packet.reverse ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})}
      />
      <circle r={landed ? 8 : 5} fill={landed ? 'white' : color} stroke={landed ? '#dc2626' : 'white'} strokeWidth={landed ? 2 : 1.5} cx={0} cy={0} />
      {landed && (
        <text fontSize={11} fill="#dc2626" fontWeight="bold" textAnchor="middle" dy={4} data-testid="packet-dropped">
          ✕
        </text>
      )}
      <text
        fontSize={8}
        fill={color}
        fontWeight="bold"
        textAnchor="middle"
        dy={-9}
        stroke="white"
        strokeWidth={3}
        paintOrder="stroke"
      >
        {landed ? 'dropped' : packet.label}
      </text>
    </g>
  )
}

export default function DeletableEdge({
  id,
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  style,
  label,
  selected,
  markerEnd,
}: EdgeProps) {
  const onEdgesChange = useNetworkStore((s) => s.onEdgesChange)
  const activePackets = useNetworkStore((s) => s.activePackets)
  const tapped = useNetworkStore((s) => s.tapEdgeId === id)
  const setTap = useNetworkStore((s) => s.setTap)

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  })

  const myPackets = activePackets.filter((p) => p.edgeId === id)

  function toggleTap(e: React.MouseEvent) {
    e.stopPropagation()
    setTap(tapped ? null : id)
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    onEdgesChange([{ type: 'remove', id }])
  }

  return (
    <>
      {tapped && (
        // A wide pale halo marks the tapped link
        <path d={edgePath} fill="none" stroke="#dc2626" strokeOpacity={0.25} strokeWidth={10} strokeLinecap="round" />
      )}
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            // A selected or tapped link's buttons sit above the devices, even where the line passes under one
            zIndex: selected || tapped ? 2000 : undefined,
          }}
        >
          {label && (
            <span className="text-xs bg-white/90 px-1.5 py-0.5 rounded border border-indigo-200 text-indigo-500 font-medium shadow-sm">
              {label as string}
            </span>
          )}
          {(selected || tapped) && (
            <button
              onClick={toggleTap}
              className={`h-5 px-1.5 rounded-full border text-[10px] font-semibold flex items-center gap-1 shadow-sm transition-colors ${
                tapped
                  ? 'bg-red-600 border-red-600 text-white hover:bg-red-700'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
              title={tapped ? 'Stop tapping: capture every packet again' : 'Capture only the packets that cross this link'}
              data-testid="tap-link"
            >
              <Radio size={10} /> {tapped ? 'Tapped' : 'Tap this link'}
            </button>
          )}
          {selected && (
            <button
              onClick={handleDelete}
              className="w-5 h-5 bg-white rounded-full border border-red-300 text-red-400 hover:bg-red-50 hover:text-red-600 text-sm flex items-center justify-center shadow-sm transition-colors"
              title="Delete connection"
            >
              ×
            </button>
          )}
        </div>
      </EdgeLabelRenderer>

      {myPackets.map((packet) => (
        <PacketDot key={packet.id} edgePath={edgePath} packet={packet} />
      ))}
    </>
  )
}
