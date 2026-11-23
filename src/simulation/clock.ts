/**
 * One clock for everything a command schedules — packet dots, capture rows, terminal lines and
 * state changes — so step mode (spec §7.4) can pause all of them together.
 *
 * Time is virtual: it runs with real time, except that in step mode it stops at each breakpoint
 * (the start of a Conversation Step) until `next()`. Everything scheduled in the same task sees
 * the same "now", so a breakpoint and the packet it guards always line up exactly.
 */

type Task = { id: number; at: number; fn: () => void }
type Breakpoint = { at: number; label: string }

export interface ClockState {
  stepMode: boolean
  paused: boolean
  /** What happens when Next is pressed, e.g. "SYN-ACK". */
  nextLabel: string
}

let tasks: Task[] = []
let breakpoints: Breakpoint[] = []
let seq = 0
let frozen = 0                    // virtual time when last synced
let syncedAt = realNow()          // real time at that sync
let paused = false
let stepMode = false
let timer: ReturnType<typeof setTimeout> | null = null
let cachedNow: number | null = null
const listeners = new Set<(s: ClockState) => void>()

function realNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Virtual time now; constant within one task. */
export function now(): number {
  if (cachedNow !== null) return cachedNow
  cachedNow = paused ? frozen : frozen + (realNow() - syncedAt)
  queueMicrotask(() => { cachedNow = null })
  return cachedNow
}

function sync(): void {
  frozen = paused ? frozen : frozen + (realNow() - syncedAt)
  syncedAt = realNow()
  cachedNow = null
}

function state(): ClockState {
  return { stepMode, paused, nextLabel: paused ? breakpoints[0]?.label ?? '' : '' }
}

function emit(): void {
  const s = state()
  listeners.forEach((l) => l(s))
}

export function subscribe(listener: (s: ClockState) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getClockState(): ClockState {
  return state()
}

/** Run `fn` after `delayMs` of virtual time. Returns an id for `cancel`. */
export function after(delayMs: number, fn: () => void): number {
  const id = ++seq
  tasks.push({ id, at: now() + Math.max(0, delayMs), fn })
  tasks.sort((a, b) => a.at - b.at || a.id - b.id)
  arm()
  return id
}

export function cancel(id: number): void {
  tasks = tasks.filter((t) => t.id !== id)
}

/** Step mode: pause before each of these moments (ms from now). Ignored when step mode is off. */
export function addBreakpoints(points: Array<{ delayMs: number; label: string }>): void {
  if (!stepMode || points.length === 0) return
  const base = now()
  for (const p of points) {
    const at = base + p.delayMs
    if (!breakpoints.some((b) => b.at === at)) breakpoints.push({ at, label: p.label })
  }
  breakpoints.sort((a, b) => a.at - b.at)
  arm()
}

/** Forget pending breakpoints (control+C) and carry on. */
export function clearBreakpoints(): void {
  breakpoints = []
  if (paused) resume()
  else arm()
}

export function setStepMode(on: boolean): void {
  stepMode = on
  if (!on) clearBreakpoints()
  emit()
}

/** Step mode: play up to the next Step. */
export function next(): void {
  if (!paused) return
  breakpoints.shift()
  resume()
}

function resume(): void {
  sync()
  paused = false
  arm()
  emit()
}

function arm(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (paused) return
  const nextTask = tasks[0]?.at ?? Infinity
  const nextBreak = stepMode ? breakpoints[0]?.at ?? Infinity : Infinity
  const due = Math.min(nextTask, nextBreak)
  if (due === Infinity) return
  timer = setTimeout(tick, Math.max(0, due - now()))
}

function tick(): void {
  timer = null
  sync()
  const t = frozen
  // Run everything due before the next breakpoint; a breakpoint wins a tie (pause *before* the Step)
  for (;;) {
    const bp = stepMode ? breakpoints[0] : undefined
    const task = tasks[0]
    if (bp && bp.at <= t && (!task || bp.at <= task.at)) {
      frozen = bp.at
      paused = true
      cachedNow = null
      emit()
      return
    }
    if (!task || task.at > t) break
    tasks.shift()
    task.fn()
  }
  arm()
}

/** Tests: start from a clean clock. */
export function resetClock(): void {
  if (timer) clearTimeout(timer)
  tasks = []; breakpoints = []; seq = 0; frozen = 0; syncedAt = realNow()
  paused = false; stepMode = false; timer = null; cachedNow = null
  emit()
}
