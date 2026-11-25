import { describe, it, expect } from 'vitest'
import { run, careConnect } from './helpers'
import { setAnimSpeed } from '../packets'

/** Step mode pauses before every capture record whose conversation id starts with conv- (store/dispatchCaptures). */
const steps = <T extends { conversationId: string }>(captures: T[]) => captures.filter((c) => c.conversationId.startsWith('conv-'))

describe('ping, timed and stepped like a conversation', () => {
  it('every echo request and reply is a Step, in order, each due when its packet leaves', () => {
    setAnimSpeed(1)
    const { captures } = run('patient', 'ping 203.0.113.80')
    const icmp = steps(captures).filter((c) => c.app === 'ICMP')
    expect(icmp.map((c) => c.info.split(',')[0]!.replace(/\s+/g, ' '))).toEqual([
      'Echo (ping) request id=0x0001', 'Echo (ping) reply id=0x0001',
      'Echo (ping) request id=0x0001', 'Echo (ping) reply id=0x0001',
      'Echo (ping) request id=0x0001', 'Echo (ping) reply id=0x0001',
      'Echo (ping) request id=0x0001', 'Echo (ping) reply id=0x0001',
    ])
    const times = icmp.map((c) => c.delayMs)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(new Set(times).size).toBe(8)
  })

  it('each reply line prints when its reply arrives, after its request leaves; the statistics come last', () => {
    setAnimSpeed(1)
    const { lines, captures } = run('patient', 'ping 203.0.113.80')
    const replies = lines.filter((l) => l.text.startsWith('64 bytes from'))
    const requests = captures.filter((c) => c.info.startsWith('Echo (ping) request'))
    expect(replies).toHaveLength(4)
    replies.forEach((l, i) => expect(l.delayMs!).toBeGreaterThan(requests[i]!.delayMs))
    const header = lines.find((l) => l.text.startsWith('PING'))!
    expect(header.delayMs ?? 0).toBeLessThan(replies[0]!.delayMs!)
    const stats = lines.find((l) => l.text.includes('packets transmitted'))!
    expect(stats.delayMs).toBe(replies[3]!.delayMs)
  })

  it('a ping with no reply: each request is a Step, and each timeout prints as the next request goes out', () => {
    setAnimSpeed(1)
    const { lines, captures } = run('patient', 'ping 10.0.0.11', careConnect())
    const requests = steps(captures).filter((c) => c.app === 'ICMP')
    expect(requests).toHaveLength(4)
    const timeouts = lines.filter((l) => l.text.startsWith('Request timeout'))
    expect(timeouts.map((l) => l.delayMs)).toEqual([requests[1]!.delayMs, requests[2]!.delayMs, requests[3]!.delayMs, timeouts[3]!.delayMs])
    expect(timeouts[3]!.delayMs!).toBeGreaterThan(requests[3]!.delayMs)
  })

  it('at Instant speed everything prints at once', () => {
    setAnimSpeed('instant')
    const { lines } = run('patient', 'ping 203.0.113.80')
    expect(lines.every((l) => !l.delayMs)).toBe(true)
    setAnimSpeed(1)
  })
})
