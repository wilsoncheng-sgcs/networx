import { useState, useCallback, useRef, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Globe, X, Lock, ShieldAlert } from 'lucide-react'
import { useNetworkStore } from '../store'
import * as clock from '../simulation/clock'
import { fetchUrl, parseUrl, BROWSER_USER_AGENT } from '../simulation/protocols/web'

interface Props {
  nodeId: string
}

interface LoadedPage {
  url: string        // with scheme, as shown in the address bar
  host: string
  secure: boolean    // HTTPS with a valid certificate
  issuer?: string
  content: string
  title: string
}

interface LoadError {
  url: string
  kind: 'refused' | 'unresolved' | 'unreachable' | 'cert'
  message: string
  host?: string
  code?: string
}

export default function Browser({ nodeId }: Props) {
  const { nodes, edges, learnMac, learnArp, dispatchPackets, dispatchCaptures, recordConnection } = useNetworkStore()
  const [addressInput, setAddressInput] = useState('')
  const [page, setPage] = useState<LoadedPage | null>(null)
  const [history, setHistory] = useState<LoadedPage[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [error, setError] = useState<LoadError | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [showSecurity, setShowSecurity] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadTimer = useRef<number | null>(null)

  useEffect(() => () => { if (loadTimer.current) clock.cancel(loadTimer.current) }, [])

  const navigate = useCallback((rawUrl: string, pushHistory = true, redirects = 0) => {
    const raw = rawUrl.trim()
    if (!raw || (loading && redirects === 0)) return
    const parsed = parseUrl(raw)
    setShowSecurity(false)
    if (!parsed) {
      setPage(null)
      setError({ url: raw, kind: 'unresolved', message: `${raw} is not a valid web address.` })
      return
    }
    setAddressInput(parsed.href)

    // The same Conversations as curl: DNS, TCP, (TLS), HTTP — without the terminal lines
    const result = fetchUrl(parsed.href, {
      selfId: nodeId, nodes, edges, learnMac, learnArp, dispatchPackets, dispatchCaptures, recordConnection,
    }, { userAgent: BROWSER_USER_AGENT, withLines: false })

    setLoading(parsed.host)
    setError(null)
    if (loadTimer.current) clock.cancel(loadTimer.current)
    // Show the page when its last packet arrives
    loadTimer.current = clock.after(result.endMs, () => {
      // 301 Moved Permanently: a browser follows the Location header by itself
      if (result.ok && result.redirect && redirects < 5) {
        navigate(result.redirect, pushHistory, redirects + 1)
        return
      }
      setLoading(null)
      if (!result.ok) {
        setPage(null)
        const host = parsed.host
        switch (result.failure) {
          case 'refused':
            setError({ url: parsed.href, kind: 'refused', message: `${host} refused to connect.\n\nNothing is listening on port ${parsed.port} (${parsed.scheme.toUpperCase()}) at ${result.ip}.\n\nERR_CONNECTION_REFUSED` })
            break
          case 'nxdomain':
            setError({ url: parsed.href, kind: 'unresolved', message: `${host}'s server IP address could not be found.\n\nThe DNS server answered: no such name (NXDOMAIN). Check the spelling, or the DNS server's A records.\n\nDNS_PROBE_FINISHED_NXDOMAIN` })
            break
          case 'cert':
            setError({ url: parsed.href, kind: 'cert', host, code: result.problem?.browserCode, message: result.problem?.explain ?? 'The certificate failed the check.' })
            break
          case 'timeout':
          case 'unreachable': {
            const why = (result.explain ?? '').replace(/^ⓘ /, '')
            const [lead, code] = result.failure === 'timeout'
              ? [`${host} took too long to respond.`, 'ERR_CONNECTION_TIMED_OUT']
              : [`${host} can't be reached from this device.`, 'ERR_ADDRESS_UNREACHABLE']
            setError({ url: parsed.href, kind: 'unreachable', message: [lead, why, code].filter(Boolean).join('\n\n') })
            break
          }
          case 'no-dns':
            setError({ url: parsed.href, kind: 'unresolved', message: `${host} could not be resolved.\n\nThis device has no DNS server to ask.\n\nERR_NAME_NOT_RESOLVED` })
            break
          case 'dns-timeout': {
            const why = (result.explain ?? '').replace(/^ⓘ /, '')
            setError({ url: parsed.href, kind: 'unresolved', message: [`${host}'s server IP address could not be found.`, why, 'ERR_NAME_NOT_RESOLVED'].filter(Boolean).join('\n\n') })
            break
          }
          default:
            setError({ url: parsed.href, kind: 'unreachable', message: `${host} is not reachable from this device.\n\nCheck the network connections.` })
        }
        return
      }
      const content = result.body ?? ''
      const title = content.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? parsed.host
      const loaded: LoadedPage = {
        url: parsed.href,
        host: parsed.host,
        secure: parsed.scheme === 'https' && !!result.cert,
        issuer: result.cert?.issuer.replace(/^CN=/, ''),
        content,
        title,
      }
      setPage(loaded)
      if (pushHistory) {
        const next = [...history.slice(0, historyIndex + 1), loaded]
        setHistory(next)
        setHistoryIndex(next.length - 1)
      }
    })
  }, [nodeId, nodes, edges, learnMac, learnArp, dispatchPackets, dispatchCaptures, recordConnection, history, historyIndex, loading])

  function show(p: LoadedPage, index: number) {
    setHistoryIndex(index)
    setPage(p)
    setAddressInput(p.url)
    setError(null)
    setShowSecurity(false)
  }

  function goBack() {
    const prev = history[historyIndex - 1]
    if (prev) show(prev, historyIndex - 1)
  }

  function goForward() {
    const next = history[historyIndex + 1]
    if (next) show(next, historyIndex + 1)
  }

  function reload() {
    if (page) navigate(page.url, false)
    else if (error) navigate(error.url, false)
  }

  const canBack = historyIndex > 0
  const canForward = historyIndex < history.length - 1
  const editing = !page || addressInput !== page.url

  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* Browser chrome */}
      <div className="relative flex items-center gap-1.5 px-2 py-2 bg-white border-b border-gray-200 flex-shrink-0">
        <button
          className={`p-1.5 rounded-md transition-colors ${canBack ? 'hover:bg-gray-100 text-gray-600' : 'text-gray-300 cursor-not-allowed'}`}
          onClick={goBack} disabled={!canBack} title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className={`p-1.5 rounded-md transition-colors ${canForward ? 'hover:bg-gray-100 text-gray-600' : 'text-gray-300 cursor-not-allowed'}`}
          onClick={goForward} disabled={!canForward} title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors"
          onClick={reload} title="Reload"
        >
          <RotateCw size={13} />
        </button>

        {/* Address bar */}
        <div className="flex-1 flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded-full px-2.5 py-1 focus-within:border-blue-400 focus-within:bg-white transition-colors min-w-0">
          {error?.kind === 'cert' && addressInput === error.url ? (
            <span className="flex items-center gap-1 text-[11px] text-red-600 font-medium flex-shrink-0 border-r border-gray-300 pr-1.5" data-testid="cert-error-chip">
              <ShieldAlert size={11} /> Not secure
            </span>
          ) : page && !editing ? (
            page.secure ? (
              <button
                className="flex items-center gap-0.5 text-gray-700 hover:bg-gray-200 rounded-full px-1 flex-shrink-0"
                onClick={() => setShowSecurity((v) => !v)}
                title="View site information"
                data-testid="secure-chip"
              >
                <Lock size={11} className="text-gray-700" />
              </button>
            ) : (
              <span className="text-[11px] text-gray-500 font-medium flex-shrink-0 border-r border-gray-300 pr-1.5" data-testid="not-secure-chip">
                Not secure
              </span>
            )
          ) : (
            <Globe size={11} className="text-gray-400 flex-shrink-0" />
          )}
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-xs outline-none text-gray-700 min-w-0"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(addressInput)}
            onFocus={(e) => e.target.select()}
            placeholder="Enter a web address…"
            spellCheck={false}
            data-testid="browser-address"
          />
          {addressInput && (
            <button className="text-gray-300 hover:text-gray-500" onClick={() => { setAddressInput(''); inputRef.current?.focus() }}>
              <X size={11} />
            </button>
          )}

          {showSecurity && page?.secure && (
            <div
              className="absolute top-full left-2 right-2 mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-20 text-xs text-gray-700 leading-relaxed"
              data-testid="security-popover"
            >
              <div className="flex items-center gap-1.5 font-semibold mb-1"><Lock size={12} /> Connection is encrypted (TLS 1.3)</div>
              <p>
                Certificate issued to <em>{page.host}</em> by {page.issuer ?? 'Networx Demo CA'}.
                This means the connection to this server is private — it does not mean the site is trustworthy.
              </p>
            </div>
          )}
        </div>

        <button
          className="px-2.5 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded-full transition-colors flex-shrink-0 disabled:opacity-50"
          onClick={() => navigate(addressInput)}
          disabled={!!loading}
        >
          Go
        </button>
      </div>

      {/* Page tab title strip */}
      {(page || loading) && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex-shrink-0">
          <Globe size={11} className={loading ? 'text-gray-300 animate-spin' : 'text-blue-400'} />
          <span className="truncate">{loading ? `Connecting to ${loading}…` : page?.title}</span>
        </div>
      )}

      {/* Page area */}
      <div className="flex-1 bg-white overflow-hidden">
        {!page && !error && !loading && (
          <div className="h-full flex items-center justify-center p-6">
            <div className="text-center text-gray-400 max-w-xs">
              <Globe size={36} className="mx-auto mb-3 text-gray-200" />
              <p className="text-sm font-medium text-gray-500 mb-1">Networx Browser</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                Type a web address above. Try both <code className="font-mono">http://</code> and{' '}
                <code className="font-mono">https://</code> with the packet capture open.
              </p>
              <div className="mt-3 text-xs text-gray-400 space-y-1">
                <p>e.g. <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">http://www.careconnect.example</code></p>
                <p>or &nbsp; <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">192.168.1.80</code></p>
              </div>
            </div>
          </div>
        )}

        {loading && !page && (
          <div className="h-full flex items-center justify-center text-xs text-gray-400">Waiting for {loading}…</div>
        )}

        {error && !loading && error.kind === 'cert' && (
          <div className="h-full overflow-auto bg-red-50 p-8" data-testid="cert-warning">
            <div className="max-w-sm mx-auto">
              <ShieldAlert size={40} className="text-red-600 mb-4" />
              <h2 className="text-lg font-semibold text-gray-800 mb-2">Your connection is not private</h2>
              <p className="text-xs text-gray-600 leading-relaxed mb-3">
                The browser stopped before loading <strong>{error.host}</strong>: its certificate failed the check, so it
                can't prove it is really {error.host}. Someone could be pretending to be this site to read what you send.
              </p>
              <p className="text-xs text-gray-700 leading-relaxed bg-white border border-red-200 rounded-md p-2.5 mb-3" data-testid="cert-reason">
                {error.message}
              </p>
              <p className="font-mono text-[11px] text-gray-500">{error.code}</p>
            </div>
          </div>
        )}

        {error && !loading && error.kind !== 'cert' && (
          <div className="h-full flex items-center justify-center p-8" data-testid="browser-error">
            <div className="text-center max-w-sm">
              <div className="text-4xl mb-4">🔌</div>
              <h2 className="text-base font-semibold text-gray-700 mb-3">This site can't be reached</h2>
              <p className="text-xs text-gray-500 whitespace-pre-line leading-relaxed">{error.message}</p>
              <button
                className="mt-4 px-4 py-1.5 bg-blue-500 text-white text-xs rounded-full hover:bg-blue-600 transition-colors"
                onClick={() => navigate(error.url, false)}
              >
                Reload
              </button>
            </div>
          </div>
        )}

        {page && !error && (
          <iframe
            key={page.url + page.content.slice(0, 32)}
            srcDoc={page.content}
            sandbox="allow-scripts"
            title={page.title}
            className="w-full h-full border-0"
          />
        )}
      </div>
    </div>
  )
}
