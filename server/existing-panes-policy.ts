export const EXISTING_PANES_ONLY_MESSAGE =
  'Generic terminal creation is disabled while FRESHELL_EXISTING_PANES_ONLY=1.'

export function existingPanesOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRESHELL_EXISTING_PANES_ONLY === '1'
}

export function assertGenericTerminalCreationAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (existingPanesOnly(env)) throw new Error(EXISTING_PANES_ONLY_MESSAGE)
}