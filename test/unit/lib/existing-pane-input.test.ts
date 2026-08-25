import { describe, expect, it } from 'vitest'
import {
  canSendExistingPaneInput,
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
})
