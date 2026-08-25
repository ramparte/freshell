import { MAX_CONCERN_PANE_INPUT_BYTES } from '@shared/concern-os-contract'

const encoder = new TextEncoder()

export type ExistingPaneInputEligibility = {
  viewState: 'loading' | 'historical' | 'live' | 'ended' | 'error'
  paneFocused: boolean
  browserFocused: boolean
  terminalFocused: boolean
  hidden: boolean
}

export function canSendExistingPaneInput(input: ExistingPaneInputEligibility): boolean {
  return input.viewState === 'live'
    && input.paneFocused
    && input.browserFocused
    && input.terminalFocused
    && !input.hidden
}

/**
 * Split only on Unicode code-point boundaries. Each returned string therefore
 * encodes independently as valid UTF-8 and never exceeds the server limit.
 */
export function splitExistingPaneInput(
  data: string,
  maxBytes = MAX_CONCERN_PANE_INPUT_BYTES,
): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('Existing-pane input chunks must allow one UTF-8 code point.')
  }
  if (!data) return []

  const chunks: string[] = []
  let chunk = ''
  let chunkBytes = 0

  for (const codePoint of data) {
    const bytes = encoder.encode(codePoint).byteLength
    if (chunk && chunkBytes + bytes > maxBytes) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += codePoint
    chunkBytes += bytes
  }
  if (chunk) chunks.push(chunk)
  return chunks
}