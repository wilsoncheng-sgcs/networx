import type { DnsRecordType } from '../types'
import * as clock from './clock'
import { NEGATIVE_TTL, normName, type DnsAnswer } from './dns'

/**
 * Each device's DNS cache (Phase 4 B4). An answer is kept until its TTL runs out on the simulation
 * clock (the shortest TTL in the answer; "no such name" for 60 s). Not saved with the network.
 * Changing a record on a DNS server does not reach the devices that cached the old answer until it expires.
 */

interface Entry {
  name: string
  qtype: DnsRecordType
  answer: DnsAnswer
  serverIp: string
  storedAt: number   // ms, simulation clock
  expiresAt: number
}

const caches = new Map<string, Map<string, Entry>>()
let nowMs: () => number = () => clock.now()

/** Tests: drive the cache from a fake clock. */
export function setDnsCacheClock(fn: () => number): void {
  nowMs = fn
}

const key = (name: string, qtype: DnsRecordType) => `${normName(name)}|${qtype}`

/** How long an answer may be cached, in seconds (0 = not at all). */
export function cacheSeconds(answer: DnsAnswer): number {
  if (answer.status === 'SERVFAIL') return 0
  if (answer.status === 'NXDOMAIN' || !answer.records.length) return NEGATIVE_TTL
  return Math.min(...answer.records.map((r) => r.ttl))
}

export function cachePut(nodeId: string, name: string, qtype: DnsRecordType, answer: DnsAnswer, serverIp: string): void {
  const seconds = cacheSeconds(answer)
  if (seconds <= 0) return
  const now = nowMs()
  const cache = caches.get(nodeId) ?? new Map<string, Entry>()
  cache.set(key(name, qtype), { name: normName(name), qtype, answer, serverIp, storedAt: now, expiresAt: now + seconds * 1000 })
  caches.set(nodeId, cache)
}

export interface CachedAnswer {
  /** The answer with each record's TTL counted down. */
  answer: DnsAnswer
  serverIp: string
  /** Seconds until the entry expires. */
  remaining: number
}

function live(entry: Entry, now: number): CachedAnswer {
  const elapsed = Math.floor((now - entry.storedAt) / 1000)
  return {
    answer: {
      ...entry.answer,
      authoritative: false,
      records: entry.answer.records.map((r) => ({ ...r, ttl: Math.max(0, r.ttl - elapsed) })),
    },
    serverIp: entry.serverIp,
    remaining: Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)),
  }
}

/** The cached answer for this question, if it hasn't expired. */
export function cacheGet(nodeId: string, name: string, qtype: DnsRecordType): CachedAnswer | null {
  const cache = caches.get(nodeId)
  const entry = cache?.get(key(name, qtype))
  if (!cache || !entry) return null
  const now = nowMs()
  if (now >= entry.expiresAt) {
    cache.delete(key(name, qtype))
    return null
  }
  return live(entry, now)
}

/** Every unexpired entry on this device, soonest to expire first. */
export function cacheEntries(nodeId: string): Array<CachedAnswer & { name: string; qtype: DnsRecordType }> {
  const cache = caches.get(nodeId)
  if (!cache) return []
  const now = nowMs()
  for (const [k, e] of cache) if (now >= e.expiresAt) cache.delete(k)
  return [...cache.values()]
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((e) => ({ ...live(e, now), name: e.name, qtype: e.qtype }))
}

export function flushDnsCache(nodeId: string): void {
  caches.delete(nodeId)
}

/** A new network was loaded: no device has cached anything yet. */
export function clearAllDnsCaches(): void {
  caches.clear()
}
