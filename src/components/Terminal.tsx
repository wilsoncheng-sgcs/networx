import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Minus } from 'lucide-react'
import { useNetworkStore } from '../store'
import { runCommand } from '../simulation/terminal'
import type { TerminalLine } from '../types'

/** Lines are stored without their timing. */
function stripDelay(line: TerminalLine): TerminalLine {
  return { type: line.type, text: line.text }
}

interface Props {
  nodeId: string
  onClose: () => void
}

export default function Terminal({ nodeId, onClose }: Props) {
  const { nodes, edges, appendTermLine, clearTerm, learnMac, learnArp, dispatchPackets, updateNodeData, dispatchCaptures, recordConnection, recentConns } = useNetworkStore()
  const node = nodes.find((n) => n.id === nodeId)
  const [input, setInput] = useState('')
  const [histIdx, setHistIdx] = useState(-1)
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  // SSH session: when set, commands run as this remote node
  const [sshNodeId, setSshNodeId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Lines still waiting to print (timed with the packet animation)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const [pending, setPending] = useState(0)

  const sshNode = sshNodeId ? nodes.find((n) => n.id === sshNodeId) : null
  const lines: TerminalLine[] = node?.data.termHistory ?? []

  const cancelPending = useCallback(() => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    setPending(0)
  }, [])

  // Reset SSH session and pending output if the panel is switched to a different node; clear on unmount
  useEffect(() => {
    setSshNodeId(null)
    return () => cancelPending()
  }, [nodeId, cancelPending])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [nodeId])

  const submit = useCallback(() => {
    if (pending > 0) return
    if (!input.trim() && input !== '') { setInput(''); return }
    const raw = input.trim()
    if (!raw) return

    // ── 'exit' while SSH'd into a remote node ───────────────────────────────
    if (sshNodeId) {
      if (raw === 'exit') {
        appendTermLine(nodeId, { type: 'input', text: `${sshNode?.data.ip ?? 'remote'}:~$ exit` })
        appendTermLine(nodeId, { type: 'info',  text: `Connection to ${sshNode?.data.ip ?? 'remote'} closed.` })
        setSshNodeId(null)
        setCmdHistory((h) => [raw, ...h].slice(0, 50))
        setHistIdx(-1)
        setInput('')
        return
      }
    }

    // Echo input with appropriate prompt
    const promptPrefix = sshNode ? `${sshNode.data.ip}:~$ ` : '$ '
    appendTermLine(nodeId, { type: 'input', text: `${promptPrefix}${raw}` })

    const result = runCommand(raw, {
      selfId: sshNodeId ?? nodeId,
      nodes, edges, learnMac, learnArp, dispatchPackets, updateNodeData,
      dispatchCaptures, recordConnection,
      schedule: (ms, fn) => { setTimeout(fn, ms) },
      recentConnections: recentConns[sshNodeId ?? nodeId] ?? [],
    })

    // Handle CLEAR signal
    if (result.length === 1 && result[0]?.text === '\x1bCLEAR') {
      clearTerm(nodeId)
    } else {
      // Detect SSH connection signal
      const sshSignal = result.find((l) => l.text.startsWith('\x1bSSH:'))
      if (sshSignal) {
        setSshNodeId(sshSignal.text.slice(5))
      }
      // Print lines now, or when their packet arrives
      const toPrint = result.filter((l) => !l.text.startsWith('\x1b'))
      const later: TerminalLine[] = []
      for (const line of toPrint) {
        if (line.delayMs) later.push(line)
        else appendTermLine(nodeId, stripDelay(line))
      }
      if (later.length) {
        setPending(later.length)
        later.forEach((line) => {
          const timer = setTimeout(() => {
            appendTermLine(nodeId, stripDelay(line))
            timersRef.current = timersRef.current.filter((t) => t !== timer)
            setPending((n) => Math.max(0, n - 1))
          }, line.delayMs)
          timersRef.current.push(timer)
        })
      }
    }

    setCmdHistory((h) => [raw, ...h].slice(0, 50))
    setHistIdx(-1)
    setInput('')
  }, [input, pending, nodeId, nodes, edges, appendTermLine, clearTerm, learnMac, learnArp, dispatchPackets, updateNodeData, dispatchCaptures, recordConnection, recentConns, sshNodeId, sshNode])

  function handleKeyDown(e: React.KeyboardEvent) {
    // control+C (the same key on macOS, not ⌘) stops a running command's output
    if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c' && pending > 0) {
      e.preventDefault()
      cancelPending()
      appendTermLine(nodeId, { type: 'input', text: '^C' })
      return
    }
    if (pending > 0) return
    if (e.key === 'Enter') { submit(); return }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(histIdx + 1, cmdHistory.length - 1)
      setHistIdx(next)
      setInput(cmdHistory[next] ?? '')
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.max(histIdx - 1, -1)
      setHistIdx(next)
      setInput(next === -1 ? '' : (cmdHistory[next] ?? ''))
    }
  }

  function lineColor(type: TerminalLine['type']): string {
    switch (type) {
      case 'input': return '#86efac'   // green
      case 'error': return '#fca5a5'   // red
      case 'info':  return '#93c5fd'   // blue
      default:      return '#e5e7eb'   // light gray
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 rounded-lg overflow-hidden font-mono text-sm">
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
        <span className="text-gray-300 text-xs font-semibold">
          {sshNode
            ? `SSH → ${sshNode.data.label} (${sshNode.data.ip})`
            : `Terminal – ${node?.data.label ?? nodeId}`}
        </span>
        <div className="flex gap-2">
          <button
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Clear"
            onClick={() => clearTerm(nodeId)}
          >
            <Minus size={14} />
          </button>
          <button
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Output area */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 && (
          <p className="text-gray-500 text-xs">Type <span className="text-green-400">help</span> to see available commands.</p>
        )}
        {lines.map((line, i) => (
          <div key={i} style={{ color: lineColor(line.type), whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-700 bg-gray-800">
        <span className="text-green-400 select-none text-xs">
          {sshNode ? `${sshNode.data.ip}:~$` : '$'}
        </span>
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-gray-100 outline-none caret-green-400 text-sm font-mono"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          readOnly={pending > 0}
          aria-disabled={pending > 0}
          placeholder={pending > 0 ? 'running…  (control+C to stop)' : 'enter command...'}
          data-testid="terminal-input"
        />
      </div>
    </div>
  )
}
