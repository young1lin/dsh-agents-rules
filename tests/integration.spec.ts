/**
 * Environment-independent integration tests.
 *
 * Everything here drives the full public surface — plugin load, four-root
 * discovery, dedup, budgets, both delivery modes, the session lifecycle, and
 * scoped assembly — through the in-memory fs only. No OS temp dirs, no real
 * home directory, no symlinks, no environment variables: the suite runs
 * identically on any CI runner and complements the real-fs smokes.
 */

import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { makeAgent, makeTree } from './helpers.ts'
import { DEFAULT_AGENTS_HOME, DEFAULT_CLAUDE_HOME, resolveConfig } from '../src/config.ts'
import { RULES_SECTION } from '../src/index.ts'

const HOME = '/it-agents-home/.agents'
const CLAUDE_HOME = '/it-agents-home/.claude'
const PROJECT = '/it-project'
const NL = String.fromCharCode(10)

/** Drive the agent/pre-step waterfall exactly as the loop's fused dispatcher does. */
async function preStep(ctx: Context, agent: Agent, messages: UserMessage[]): Promise<PreStepDecision> {
  return await ctx.waterfall(
    scopeTarget(agent, agent), 'agent/pre-step',
    { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages }),
  )
}

function text(message: UserMessage): string {
  return message.content.map(part => part.type === 'text' ? part.text : '').join('')
}

/** Simulate the loop committing a message to the durable session log. */
function commit(agent: Agent, message: UserMessage, seq: number): void {
  const session = agent.session as unknown as { events: unknown[]; surface: { nodes: Set<number> } }
  session.events.push({ type: 'user/message', seq, data: message })
  session.surface.nodes.add(seq)
}

/** Extract the rendered rules section from a complete prompt. */
function sectionText(prompt: string): string {
  const marker = 'The following agent rules'
  const start = prompt.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  return prompt.slice(start)
}

describe('agents-rules environment-independent integration', () => {
  it('composes four roots, cross-convention dedup, and scoped assembly in one tree', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, claudeHome: CLAUDE_HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Global canonical body.')
    fs.write(CLAUDE_HOME + '/rules/style.md', 'Global canonical body.')
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/api.md', 'Agents project body.')
    fs.write(PROJECT + '/.claude/rules/claude-api.md', 'Claude project body.')
    const agent = makeAgent(PROJECT)
    const scopeKey = {}
    createScope(ctx, scopeKey)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: scopeKey })
    expect(assembly.sections.map(section => section.name)).toEqual([
      'harness:identity', 'deployment:persona-prefix', RULES_SECTION, 'deployment:persona-suffix',
    ])
    const body = sectionText(renderPrompt(assembly))
    const order = ['Global canonical body.', 'Agents project body.', 'Claude project body.'].map(s => body.indexOf(s))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(body).toContain('path=".agents/rules/api.md"')
    expect(body).toContain('path=".claude/rules/claude-api.md"')
    expect(body.match(/Global canonical body\./g)?.length).toBe(1)
    expect(body).toContain(
      'Rule files skipped as exact duplicates of an earlier rule file: '
      + '/it-agents-home/.claude/rules/style.md (= /it-agents-home/.agents/rules/style.md)',
    )
  })

  it('drops the broadest rule under a tight budget and records the omission', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 400 })
    fs.write(HOME + '/rules/big.md', 'Wide global rule body.' + 'x'.repeat(500))
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/api.md', 'Project body.')
    const body = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })))
    expect(body).toContain('Project body.')
    expect(body).not.toContain('Wide global rule body.')
    expect(body).toContain('Rule files omitted to fit the section budget: /it-agents-home/.agents/rules/big.md')
    expect(body).not.toContain('[Section truncated')
  })

  it('skips an oversized claude-root file with the per-file cap note', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, claudeHome: CLAUDE_HOME, maxBytes: 65536, maxFileBytes: 32 })
    fs.write(HOME + '/rules/style.md', 'Small global rule.')
    fs.write(CLAUDE_HOME + '/rules/huge.md', 'y'.repeat(100))
    const body = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })))
    expect(body).toContain('Small global rule.')
    expect(body).toContain('Rule files skipped for exceeding the per-file size cap: /it-agents-home/.claude/rules/huge.md')
    expect(body).not.toContain('yyyyy')
  })

  it('context mode: one durable message carrying dedup, origins, and the frame', async () => {
    const { ctx, fs } = await makeTree({ mode: 'context', agentsHome: HOME, claudeHome: CLAUDE_HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Global canonical body.')
    fs.write(CLAUDE_HOME + '/rules/style.md', 'Global canonical body.')
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/api.md', 'Agents project body.')
    fs.write(PROJECT + '/.claude/rules/claude-api.md', 'Claude project body.')
    const decision = await preStep(ctx, makeAgent(PROJECT), [
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', form: 'prompt' } }),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]
    expect(injected.source.kind).toBe('agents-rules')
    const body = text(injected)
    expect(body).toContain('<system-reminder>')
    expect(body).toContain('<agent_rules>')
    expect(body).toContain('origin="global"')
    expect(body).toContain('origin="project"')
    expect(body.match(/Global canonical body\./g)?.length).toBe(1)
    expect(body).toContain('exact duplicates of an earlier rule file')
  })

  it('context mode: freeze, reload for a new agent, and replace on a fork', async () => {
    const { ctx, fs } = await makeTree({ mode: 'context', agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/lifecycle.md', 'Lifecycle v1.')
    fs.write(PROJECT + '/.git', '')
    const agentA = makeAgent(PROJECT)
    const first = await preStep(ctx, agentA, [])
    if (first.kind !== 'enter') throw new Error('expected enter')
    const firstMessage = first.messages.find(m => m.source.kind === 'agents-rules') as UserMessage
    if (firstMessage === undefined) throw new Error('expected rules message')
    commit(agentA, firstMessage, 1)
    fs.write(HOME + '/rules/lifecycle.md', 'Lifecycle v2 edited mid-session.')
    fs.write(HOME + '/rules/added.md', 'Added rule file.')
    expect(await preStep(ctx, agentA, [])).toEqual({ kind: 'enter', messages: [] })
    const next = await preStep(ctx, makeAgent(PROJECT), [])
    if (next.kind !== 'enter') throw new Error('expected enter')
    const nextBody = next.messages.map(text).join('')
    expect(nextBody).toContain('Lifecycle v2 edited mid-session.')
    expect(nextBody).toContain('Added rule file.')
    const fork = makeAgent(PROJECT, { parentSession: 'session-parent', events: [{ type: 'user/message', seq: 1, data: firstMessage }] })
    const forkDecision = await preStep(ctx, fork, [])
    if (forkDecision.kind !== 'enter') throw new Error('expected enter')
    const forkBody = forkDecision.messages.map(text).join('')
    expect(forkBody).toContain('replaces every earlier agent-rules snapshot')
    expect(forkBody).toContain('Lifecycle v2 edited mid-session.')
  })

  it('context mode: degrades to a no-op without an fs provider', async () => {
    const { ctx } = await makeTree({ mode: 'context', agentsHome: HOME, maxBytes: 65536, withFs: false })
    const decision = await preStep(ctx, makeAgent(PROJECT), [])
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('resolves the project root by marker walk-up from a deeply nested cwd', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Global rule body.')
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/nested/deep.md', 'Deep project rule.')
    const body = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT + '/a/b/c/d') })))
    expect(body).toContain('Global rule body.')
    expect(body).toContain('path=".agents/rules/nested/deep.md"')
  })

  it('falls back to the cwd itself when no marker exists above it', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    const NESTED = PROJECT + '/markerless'
    fs.write(HOME + '/rules/style.md', 'Global rule body.')
    fs.write(NESTED + '/.agents/rules/cwd-rule.md', 'Cwd-rooted project rule.')
    const body = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(NESTED) })))
    expect(body).toContain('Global rule body.')
    expect(body).toContain('path=".agents/rules/cwd-rule.md"')
  })

  it('expands the default homes under the OS home without any fixture planting', () => {
    const resolved = resolveConfig({ maxBytes: 1 })
    expect(resolved.agentsHome).toBe(homedir() + DEFAULT_AGENTS_HOME.slice(1))
    expect(resolved.claudeHome).toBe(homedir() + DEFAULT_CLAUDE_HOME.slice(1))
    expect(resolved.claudeCompat).toBe(true)
  })
})
