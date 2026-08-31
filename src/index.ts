/**
 * AGENTS rules adapter for DeepSeek Harness: global (~/.agents/rules) and
 * project (.agents/rules) rule directories delivered to the model once per
 * session, snapshotted at that session's first step.
 *
 * Two delivery modes. `context` (default) publishes a durable user-role
 * message framed like the skill catalog — visible in the conversation,
 * reconstructable from the session log. `system-prompt` splices one section
 * into each assembly instead. Both freeze the snapshot per session: mid-session
 * file edits never enter an existing conversation; a fresh session reads the
 * current files; a fork replaces an inherited snapshot that no longer matches.
 *
 * @module dsh-agents-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { AssembledSection, AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { resolveConfig } from './config.ts'
import { collectRules, findProjectRoot, type RulesRoot } from './discovery.ts'
import { renderRulesBody, renderRulesSection, SECTION_INTRO } from './render.ts'
import {
  digestSnapshot,
  rulesFirstMessage,
  rulesHistory,
  rulesMessageInBatch,
  rulesRemovedMessage,
  rulesUpdateMessage,
} from './inject.ts'
import type { Config as ConfigShape } from './types.ts'

export type { ResolvedConfig, RuleFile, RuleOrigin } from './types.ts'
export { rulesFirstMessage, rulesHistory, digestSnapshot } from './inject.ts'

/** Cordis plugin name. */
export const name = 'agents-rules'

/** Name of the system-prompt section this plugin injects in that mode. */
export const RULES_SECTION = 'agents-rules:rules'

/** Re-exported for context-mode consumers that render the section intro. */
export const CONTEXT_INTRO = SECTION_INTRO

/** Fixed project rules directory name inside the project root. */
const PROJECT_RULES_SEGMENTS = ['.agents', 'rules']

/** Plugin config schema; maxBytes is required so deployments choose a budget explicitly. */
export const Config: z<ConfigShape> = z.object({
  mode: z.union(['context', 'system-prompt']).default('context'),
  agentsHome: z.string().default('~/.agents'),
  projectRootMarkers: z.array(z.string()).default(['.git']),
  maxBytes: z.number().required(),
  maxFileBytes: z.number().default(262144),
})

/**
 * Insert the rules section right after the deployment persona (or append when
 * no persona section is present), leaving every other section untouched.
 * @param assembly - the authoritative assembly returned by the waterfall.
 * @param text - the complete rendered rules section.
 * @returns a copy of the assembly with the rules section inserted.
 */
function spliceSection(assembly: PromptAssembly, text: string): PromptAssembly {
  const section: AssembledSection = { name: RULES_SECTION, text }
  const sections = [...assembly.sections]
  const personaIndex = sections.findIndex(entry => entry.name === PERSONA_SECTION)
  if (personaIndex >= 0) sections.splice(personaIndex + 1, 0, section)
  else sections.push(section)
  return { ...assembly, sections }
}

/**
 * Load and render the rules snapshot for one agent.
 *
 * Reads are bounded and cancellation-safe. Provider absence and read failures
 * degrade to an empty snapshot (no injection) with one warning per agent.
 * @param ctx - the plugin context (diagnostics and optional fs lookup).
 * @param resolved - validated config.
 * @param agent - the agent whose session cwd scopes project rules.
 * @param signal - aborts the snapshot read.
 * @returns the complete snapshot text, or an empty string when nothing applies.
 */
async function snapshotSection(
  ctx: Context,
  resolved: ReturnType<typeof resolveConfig>,
  mode: 'context' | 'system-prompt',
  agent: Agent,
  signal: AbortSignal | undefined,
): Promise<string> {
  const fileSystem = ctx.get('fs')
  if (fileSystem === undefined) {
    ctx.logger.warn('agents-rules: no fs provider is mounted; agent rules are not loaded')
    return ''
  }
  signal?.throwIfAborted()
  const cwd = agent.session.header.cwd ?? process.cwd()
  const projectRoot = await findProjectRoot(fileSystem, cwd, resolved.projectRootMarkers, signal)
  const globalDisplayRoot = resolved.agentsHomeDisplay + '/rules'
  const roots: RulesRoot[] = [
    { origin: 'global', dir: join(resolved.agentsHome, 'rules'), displayRoot: globalDisplayRoot },
    { origin: 'project', dir: join(projectRoot, ...PROJECT_RULES_SEGMENTS), displayRoot: '.agents/rules' },
  ]
  const { files, oversized } = await collectRules(fileSystem, roots, resolved.maxFileBytes, signal, (message, error) => {
    ctx.logger.warn(message + ': %o', error)
  })
  return mode === 'system-prompt'
    ? renderRulesSection(files, resolved.maxBytes, oversized)
    : renderRulesBody(files, resolved.maxBytes, oversized)
}

/**
 * Mount the rules adapter in the configured mode.
 * @param ctx - the plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const snapshots = new WeakMap<Agent, Promise<string>>()

  /** Read the files once per agent; later calls reuse the frozen snapshot. */
  const load = (agent: Agent, signal: AbortSignal | undefined): Promise<string> => {
    let pending = snapshots.get(agent)
    if (pending === undefined) {
      pending = snapshotSection(ctx, resolved, config.mode ?? 'context', agent, signal).then(undefined, (error: unknown) => {
        snapshots.delete(agent)
        if (signal?.aborted) throw error
        ctx.logger.warn('agents-rules: loading agent rules failed; rules are omitted for this request: %o', error)
        return ''
      })
      snapshots.set(agent, pending)
    }
    return pending
  }

  if (config.mode === 'system-prompt') {
    ctx.on('system-prompt/assemble', async (
      _assembly: PromptAssembly,
      context: AssembleContext,
      next: () => Promise<PromptAssembly>,
    ): Promise<PromptAssembly> => {
      const transformed = await next()
      const agent = context.agent
      if (agent === undefined || resolved.maxBytes <= 0) return transformed
      const text = await load(agent, context.signal)
      if (text.length === 0) return transformed
      return spliceSection(transformed, text)
    })
    return
  }

  ctx.on('agent/pre-step', async (
    { agent, signal }: { agent: Agent; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || resolved.maxBytes <= 0) return decision
    signal.throwIfAborted()
    const history = rulesHistory(agent)
    const existing = rulesMessageInBatch(decision.messages)

    // Frozen: this session already shows a rules snapshot and is not a fork.
    const fork = agent.session.header.parentSession !== undefined
    if (history.visibleDigest !== undefined && !fork) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter(m => m.id !== existing.message.id) }
    }

    const snapshot = await load(agent, signal)
    signal.throwIfAborted()
    const digest = digestSnapshot(snapshot)

    if (history.visibleDigest !== undefined) {
      // Fork: keep an inherited snapshot that still matches; replace a stale one.
      if (existing !== undefined && existing.digest === digest) return decision
      if (digest === history.visibleDigest && existing === undefined) return decision
      const replacement = snapshot.length > 0 ? rulesUpdateMessage(snapshot) : rulesRemovedMessage()
      return { kind: 'enter', messages: appendOrReplace(decision.messages, existing?.message.id, replacement) }
    }

    // No visible snapshot: first publication, or restore one compacted away.
    if (snapshot.length === 0) {
      if (!history.published) {
        return existing === undefined
          ? decision
          : { kind: 'enter', messages: decision.messages.filter(m => m.id !== existing.message.id) }
      }
      // Rules existed earlier in this log but the files now read empty and the
      // snapshot is no longer visible; do not resurrect stale content.
      return decision
    }
    if (existing !== undefined && existing.digest === digest) return decision
    const message = history.published ? rulesUpdateMessage(snapshot) : rulesFirstMessage(snapshot)
    return { kind: 'enter', messages: appendOrReplace(decision.messages, existing?.message.id, message) }
  })
}

/** Append a message, or replace the earlier rules message at the same position. */
function appendOrReplace(messages: readonly UserMessage[], replaceId: string | undefined, message: UserMessage): UserMessage[] {
  if (replaceId === undefined) return [...messages, message]
  return messages.map(entry => entry.id === replaceId ? message : entry)
}