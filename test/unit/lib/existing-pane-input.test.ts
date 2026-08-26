import { describe, expect, it, vi } from 'vitest'
import {
  canSendExistingPaneInput,
  createExistingPaneInputBatcher,
  splitExistingPaneInput,
} from '../../../src/lib/existing-pane-input'

const encoder = new TextEncoder()

describe('existing-pane browser input policy', () => {
  it('allows input only from the live, visible, browser-focused, terminal-focused pane', () => {
    const eligible = {
      viewState: 'live' as const,
      paneFocused: true,
      browserFocused: true,
      terminalFocused: true,
      hidden: false,
    }

    expect(canSendExistingPaneInput(eligible)).toBe(true)
    expect(canSendExistingPaneInput({ ...eligible, paneFocused: false })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, browserFocused: false })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, terminalFocused: false })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, hidden: true })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, viewState: 'ended' })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, viewState: 'historical' })).toBe(false)
    expect(canSendExistingPaneInput({ ...eligible, viewState: 'loading' })).toBe(false)
  })

  it('chunks on Unicode code-point boundaries at no more than 512 UTF-8 bytes', () => {
    const input = `${'a'.repeat(511)}é\u0003${'🙂'.repeat(130)}\r`
    const chunks = splitExistingPaneInput(input)

    expect(chunks.join('')).toBe(input)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => encoder.encode(chunk).byteLength <= 512)).toBe(true)
    expect(chunks.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true)
    expect(splitExistingPaneInput('')).toEqual([])
  })

  it('coalesces ordinary keystrokes into one ordered frame-sized request', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const errors: unknown[] = []
    const batcher = createExistingPaneInputBatcher(
      async (data) => { sent.push(data) },
      (error) => { errors.push(error) },
      16,
    )

    batcher.enqueue('h')
    batcher.enqueue('e')
    batcher.enqueue('l')
    batcher.enqueue('l')
    batcher.enqueue('o')
    expect(sent).toEqual([])

    await vi.advanceTimersByTimeAsync(15)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await batcher.flush()

    expect(sent).toEqual(['hello'])
    expect(errors).toEqual([])
    batcher.dispose()
    vi.useRealTimers()
  })

  it('coalesces frame batches behind one unresolved request into one successor', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const batcher = createExistingPaneInputBatcher(
      async (data) => {
        sent.push(data)
        if (sent.length === 1) await firstBlocked
      },
      () => undefined,
      16,
    )

    batcher.enqueue('abc')
    await vi.advanceTimersByTimeAsync(16)
    expect(sent).toEqual(['abc'])

    batcher.enqueue('d')
    await vi.advanceTimersByTimeAsync(16)
    batcher.enqueue('e')
    await vi.advanceTimersByTimeAsync(16)
    expect(sent).toEqual(['abc'])
    releaseFirst()
    await batcher.flush()
    expect(sent).toEqual(['abc', 'de'])

    batcher.dispose()
    vi.useRealTimers()
  })

  it('keeps control bytes at their earliest ordered position in a coalesced successor', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const batcher = createExistingPaneInputBatcher(
      async (data) => {
        sent.push(data)
        if (sent.length === 1) await firstBlocked
      },
      () => undefined,
      16,
    )

    batcher.enqueue('first')
    await vi.advanceTimersByTimeAsync(16)
    batcher.enqueue('abc')
    batcher.enqueue('\r')
    batcher.enqueue('def')

    releaseFirst()
    await batcher.flush()
    expect(sent).toEqual(['first', 'abc\rdef'])

    batcher.dispose()
    vi.useRealTimers()
  })

  it('preserves UTF-8 byte order and 512-byte bounds in queued successors', async () => {
    const sent: string[] = []
    const input = `${'a'.repeat(510)}é${'🙂'.repeat(130)}tail`
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const batcher = createExistingPaneInputBatcher(
      async (data) => {
        sent.push(data)
        if (sent.length === 1) await firstBlocked
      },
      () => undefined,
      0,
    )

    batcher.enqueue('blocked')
    await new Promise((resolve) => setTimeout(resolve, 0))
    batcher.enqueue(input)
    releaseFirst()
    await batcher.flush()

    expect(sent.slice(1).join('')).toBe(input)
    expect(sent.length).toBeGreaterThan(2)
    expect(sent.every((chunk) => encoder.encode(chunk).byteLength <= 512)).toBe(true)
    expect(sent.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true)
    batcher.dispose()
  })

  it('drops coalesced successors after the in-flight request fails', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const errors: unknown[] = []
    const failure = new Error('stale generation')
    let rejectFirst!: (error: unknown) => void
    const firstBlocked = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    const batcher = createExistingPaneInputBatcher(
      async (data) => {
        sent.push(data)
        await firstBlocked
      },
      (error) => { errors.push(error) },
      16,
    )

    batcher.enqueue('first')
    await vi.advanceTimersByTimeAsync(16)
    batcher.enqueue('never-1')
    await vi.advanceTimersByTimeAsync(16)
    batcher.enqueue('never-2')
    rejectFirst(failure)
    await batcher.flush()

    expect(sent).toEqual(['first'])
    expect(errors).toEqual([failure])
    batcher.dispose()
    vi.useRealTimers()
  })
})
