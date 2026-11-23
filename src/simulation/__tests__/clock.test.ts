import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as clock from '../clock'

describe('the shared clock and step mode (spec §7.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    clock.resetClock()
  })
  afterEach(() => {
    clock.resetClock()
    vi.useRealTimers()
  })

  function schedule(log: string[]) {
    clock.after(0, () => log.push('SYN'))
    clock.after(100, () => log.push('SYN-ACK'))
    clock.after(200, () => log.push('ACK'))
    clock.addBreakpoints([
      { delayMs: 0, label: '[SYN]' },
      { delayMs: 100, label: '[SYN, ACK]' },
      { delayMs: 200, label: '[ACK]' },
    ])
  }

  it('without step mode, runs everything on time', async () => {
    const log: string[] = []
    schedule(log)
    await vi.advanceTimersByTimeAsync(250)
    expect(log).toEqual(['SYN', 'SYN-ACK', 'ACK'])
  })

  it('in step mode, pauses before each step until next()', async () => {
    clock.setStepMode(true)
    const log: string[] = []
    schedule(log)
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual([])
    expect(clock.getClockState()).toMatchObject({ paused: true, nextLabel: '[SYN]' })

    clock.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual(['SYN'])
    expect(clock.getClockState().nextLabel).toBe('[SYN, ACK]')

    clock.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual(['SYN', 'SYN-ACK'])

    clock.next()
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual(['SYN', 'SYN-ACK', 'ACK'])
    expect(clock.getClockState().paused).toBe(false)
  })

  it('things scheduled inside a step keep their spacing after Next', async () => {
    clock.setStepMode(true)
    const log: string[] = []
    clock.after(100, () => log.push('hop 1'))
    clock.after(150, () => log.push('hop 2'))
    clock.addBreakpoints([{ delayMs: 100, label: 'step' }])
    await vi.advanceTimersByTimeAsync(5000)
    expect(log).toEqual([])
    clock.next()
    await vi.advanceTimersByTimeAsync(10)
    expect(log).toEqual(['hop 1'])
    await vi.advanceTimersByTimeAsync(50)
    expect(log).toEqual(['hop 1', 'hop 2'])
  })

  it('leaving step mode carries on at once', async () => {
    clock.setStepMode(true)
    const log: string[] = []
    schedule(log)
    await vi.advanceTimersByTimeAsync(1000)
    clock.setStepMode(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(log).toEqual(['SYN', 'SYN-ACK', 'ACK'])
  })

  it('cancel stops a task; clearBreakpoints resumes', async () => {
    clock.setStepMode(true)
    const log: string[] = []
    const id = clock.after(10, () => log.push('cancelled'))
    clock.after(20, () => log.push('kept'))
    clock.addBreakpoints([{ delayMs: 5, label: 'x' }])
    await vi.advanceTimersByTimeAsync(100)
    clock.cancel(id)
    clock.clearBreakpoints()
    await vi.advanceTimersByTimeAsync(100)
    expect(log).toEqual(['kept'])
  })
})
