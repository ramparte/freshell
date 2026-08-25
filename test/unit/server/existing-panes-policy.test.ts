// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertGenericTerminalCreationAllowed,
  existingPanesOnly,
} from '../../../server/existing-panes-policy.js'

describe('existing panes only policy', () => {
  it('rejects generic terminal creation only for the explicit value 1', () => {
    expect(existingPanesOnly({ FRESHELL_EXISTING_PANES_ONLY: '1' })).toBe(true)
    expect(() => assertGenericTerminalCreationAllowed({
      FRESHELL_EXISTING_PANES_ONLY: '1',
    })).toThrow(/Generic terminal creation is disabled/)

    expect(existingPanesOnly({ FRESHELL_EXISTING_PANES_ONLY: '0' })).toBe(false)
    expect(() => assertGenericTerminalCreationAllowed({})).not.toThrow()
  })
})