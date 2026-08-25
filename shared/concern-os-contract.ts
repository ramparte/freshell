import { z } from 'zod'

const NonEmptyString = z.string().trim().min(1)

export const TmuxPaneIdSchema = z.string().regex(/^%\d+$/)
export const MAX_CONCERN_PANE_INPUT_BYTES = 512

export const ConcernAttentionSchema = z.object({
  pane_id: TmuxPaneIdSchema,
  state: z.enum(['needs', 'ready', 'working', 'idle']),
  severity: z.number().int().nonnegative(),
  why: z.string(),
}).passthrough()

export const ConcernLiveIdentitySchema = z.object({
  tmux_server_pid: z.number().int().positive(),
  tmux_server_start_ticks: z.number().int().nonnegative(),
  pane_id: TmuxPaneIdSchema,
  pane_pid: z.number().int().positive(),
  pane_start_ticks: z.number().int().nonnegative(),
  amplifier_pid: z.number().int().positive(),
  amplifier_start_ticks: z.number().int().nonnegative(),
}).passthrough()

export const ConcernResolvableAttachmentSchema = z.object({
  state: z.literal('resolvable'),
  pane_id: TmuxPaneIdSchema,
  live_identity: ConcernLiveIdentitySchema,
}).passthrough()

export const ConcernBlockedAttachmentSchema = z.object({
  state: z.literal('blocked'),
  reason: z.string(),
}).passthrough()

export const ConcernAttachmentSchema = z.discriminatedUnion('state', [
  ConcernResolvableAttachmentSchema,
  ConcernBlockedAttachmentSchema,
])

export const ConcernSessionSchema = z.object({
  id: NonEmptyString,
  session_id: NonEmptyString,
  provider: z.literal('amplifier'),
  historical: z.boolean(),
  live: z.boolean(),
  status: NonEmptyString,
  working_dir: z.string(),
  created: z.string(),
  last_activity_at: z.number(),
  attachment: ConcernAttachmentSchema.optional(),
  attention: ConcernAttentionSchema.nullish(),
}).passthrough()

export const ConcernSessionCatalogSchema = z.object({
  ok: z.literal(true),
  items: z.array(ConcernSessionSchema),
  inventory: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
  }).passthrough(),
}).passthrough()

export const ConcernSessionRecordSchema = z.object({
  ok: z.literal(true),
  item: ConcernSessionSchema,
}).passthrough()

export const ConcernPaneSnapshotSchema = z.object({
  ok: z.literal(true),
  pane_id: TmuxPaneIdSchema,
  data: z.string(),
  input_enabled: z.boolean(),
  next_input_sequence: z.number().int().positive(),
}).passthrough()

export const ConcernPaneInputRequestSchema = z.object({
  sequence: z.number().int().positive(),
  data: z.string().min(1),
}).strict()

export const ConcernPaneInputResponseSchema = z.object({
  ok: z.literal(true),
  pane_id: TmuxPaneIdSchema,
  sequence: z.number().int().positive(),
}).strict()

export type ConcernAttention = z.infer<typeof ConcernAttentionSchema>
export type ConcernLiveIdentity = z.infer<typeof ConcernLiveIdentitySchema>
export type ConcernResolvableAttachment = z.infer<typeof ConcernResolvableAttachmentSchema>
export type ConcernAttachment = z.infer<typeof ConcernAttachmentSchema>
export type ConcernSession = z.infer<typeof ConcernSessionSchema>
export type ConcernSessionCatalog = z.infer<typeof ConcernSessionCatalogSchema>
export type ConcernPaneSnapshot = z.infer<typeof ConcernPaneSnapshotSchema>
export type ConcernPaneInputRequest = z.infer<typeof ConcernPaneInputRequestSchema>
export type ConcernPaneInputResponse = z.infer<typeof ConcernPaneInputResponseSchema>