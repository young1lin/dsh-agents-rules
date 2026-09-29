/**
 * Durable rules-context message construction and session-history scanning.
 *
 * @module dsh-agents-rules/inject
 */

import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Durable source record for one injected agent-rules snapshot. */
export interface AgentsRulesSource {
  readonly kind: 'agents-rules'
  readonly form: 'rules'
  /** Marks a superseding snapshot rather than this session's first publication. */
  readonly update?: true
  /** SHA-256 over the rendered snapshot text, for fork/change comparison. */
  readonly digest: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agents-rules': AgentsRulesSource
  }
}

/** Opening line of the first-load frame (pinned model-visible text). */
const FIRST_OPENING =
  'The following agent rules were loaded once at session start and are frozen for this session. ' +
  'Use them as guidance when applicable. They do not override system, developer, or direct user instructions.'

/** Opening line of a superseding snapshot (fork picked up changed files). */
const UPDATE_OPENING =
  'The agent rules changed on this session\u2019s fork. This complete snapshot replaces every earlier agent-rules snapshot in this session:'

/** Opening line when a fork enters a workspace with no rules at all. */
const REMOVED_OPENING =
  'The agent rules that earlier snapshots carried no longer apply; no agent rules are currently loaded.'

/** Frame tags that rule content must not be able to close. */
const FRAME_CLOSER = '</system-reminder>'
const BLOCK_CLOSER = '</agent_rules>'

/**
 * Escape frame-closing tag sequences in repository-controlled rule text so
 * file content cannot close the plugin-owned frame.
 * @param text - rendered rule content.
 * @returns content with closing-tag literals neutralized.
 */
export function escapeFrameClosers(text: string): string {
  return text
    .replaceAll(FRAME_CLOSER, '&lt;/system-reminder&gt;')
    .replaceAll(BLOCK_CLOSER, '&lt;/agent_rules&gt;')
}

/**
 * SHA-256 identity of one rendered snapshot.
 * @param text - the rendered rules snapshot.
 * @returns hex digest.
 */
export function digestSnapshot(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function framed(opening: string, body: string | undefined, update: boolean, digest: string): UserMessage {
  const lines = ['<system-reminder>', opening]
  if (body !== undefined && body.length > 0) {
    lines.push('', '<agent_rules>', escapeFrameClosers(body), '</agent_rules>')
  }
  lines.push('</system-reminder>')
  return createUserMessage({
    content: [{ type: 'text', text: lines.join(String.fromCharCode(10)) }],
    source: update
      ? { kind: 'agents-rules', form: 'rules', update: true, digest }
      : { kind: 'agents-rules', form: 'rules', digest },
  })
}

/**
 * Build the first-load rules context message.
 * @param body - rendered rules snapshot.
 * @returns the durable user message.
 */
export function rulesFirstMessage(body: string): UserMessage {
  return framed(FIRST_OPENING, body, false, digestSnapshot(body))
}

/**
 * Build a superseding rules context message (fork with changed files).
 * @param body - rendered rules snapshot.
 * @returns the durable user message.
 */
export function rulesUpdateMessage(body: string): UserMessage {
  return framed(UPDATE_OPENING, body, true, digestSnapshot(body))
}

/**
 * Build the removal notice (fork into a workspace with no rules).
 * @returns the durable user message.
 */
export function rulesRemovedMessage(): UserMessage {
  return framed(REMOVED_OPENING, undefined, true, digestSnapshot(''))
}

/** Visible/published state of rules messages in one session log. */
export interface RulesHistory {
  /** Digest of the newest rules message still visible on the surface, when one is. */
  readonly visibleDigest?: string
  /** Whether any rules message exists in the complete log (visible or compacted away). */
  readonly published: boolean
}

function readDigest(source: unknown): string | undefined {
  const digest = (source as { digest?: unknown }).digest
  return typeof digest === 'string' ? digest : undefined
}

/**
 * Scan one session's durable log for rules messages.
 *
 * Seed validation only guarantees a source object with a non-empty kind, so an
 * unreadable record counts as "not this plugin's message" rather than throwing
 * inside the step listener.
 * @param agent - the live agent whose session log to scan.
 * @returns visibility and publication state.
 */
export function rulesHistory(agent: Agent): RulesHistory {
  const visible = new Set(agent.session.surface.nodes)
  // dsh 0.1.5 made the event log private; snapshotEvents() is the frozen
  // full-log accessor (seq = array index, same contiguity as the old field).
  const events = agent.session.snapshotEvents()
  let published = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source.kind !== 'agents-rules') continue
    const digest = readDigest(event.data.source)
    if (digest === undefined) continue
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published }
  }
  return { published }
}

/**
 * Find an agents-rules message inside a proposed entering batch.
 * @param messages - the batch a downstream listener proposed.
 * @returns the message and its digest, when present.
 */
export function rulesMessageInBatch(
  messages: readonly UserMessage[],
): { message: UserMessage; digest: string } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'agents-rules') continue
    const digest = readDigest(message.source)
    if (digest !== undefined) return { message, digest }
  }
  return undefined
}
