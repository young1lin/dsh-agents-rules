/**
 * Real-fs end-to-end smoke (context mode): built lib + real LocalFileSystem +
 * planted rule files, driven through the agent/pre-step waterfall.
 * All fixtures live under a throwaway temp dir.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as agentsRules from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-agents-rules-realfs-'))
const HOME = join(root, 'home')
const WS = join(root, 'ws')

mkdirSync(join(HOME, '.agents', 'rules'), { recursive: true })
mkdirSync(join(WS, '.agents', 'rules'), { recursive: true })
writeFileSync(join(HOME, '.agents', 'rules', 'global-style.md'), 'Answer in concise English.')
writeFileSync(join(WS, '.agents', 'rules', 'proj-testing.md'), 'Run pnpm test before claiming done.')

const ctx = new Context()
new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 })
await ctx.plugin(agentsRules, { mode: 'context', agentsHome: join(HOME, '.agents'), claudeCompat: false, maxBytes: 65536 })

let seq = 0
const makeAgent = (events = []) => ({
  session: {
    header: { cwd: WS },
    events,
    snapshotEvents: () => events,  // dsh 0.1.7 exposes the log via this accessor
    surface: { nodes: new Set(events.map(e => e.seq)) },
  },
})
const preStep = async (agent, messages = []) => await ctx.waterfall(
  scopeTarget(agent, agent), 'agent/pre-step',
  { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'enter', messages }),
)
const text = (m) => m.content.map(p => p.type === 'text' ? p.text : '').join('')

const agentA = makeAgent()
const first = await preStep(agentA)
const firstText = first.messages.map(text).join('|')
console.log('context message injected:', first.messages.length === 1 && firstText.includes('agent_rules'))
console.log('global rule in message:', firstText.includes('Answer in concise English.'))
console.log('project rule in message:', firstText.includes('Run pnpm test before claiming done.'))

// freeze: commit the message, edit files, re-run — no change
const rulesMsg = first.messages.find(m => m.source.kind === 'agents-rules')
agentA.session.events.push({ type: 'user/message', seq: ++seq, data: rulesMsg })
agentA.session.surface.nodes.add(seq)
writeFileSync(join(HOME, '.agents', 'rules', 'global-style.md'), 'EDITED MID SESSION')
writeFileSync(join(HOME, '.agents', 'rules', 'late-rule.md'), 'Added mid session.')
const again = await preStep(agentA, [])
console.log('frozen for same session:', again.messages.length === 0)

// new session: fresh agent reads current files
const agentB = makeAgent()
const next = await preStep(agentB)
const nextText = next.messages.map(text).join('')
console.log('new session reloads edits:', nextText.includes('EDITED MID SESSION'))
console.log('new session picks up added rule:', nextText.includes('Added mid session.'))

// fork inherits the stale message, replaces it
const forkAgentBase = makeAgent([{ type: 'user/message', seq: 1, data: rulesMsg }])
forkAgentBase.session.header.parentSession = 'session-parent'
const fork = forkAgentBase
const forkDecision = await preStep(fork)
const forkText = forkDecision.messages.map(text).join('')
console.log('fork replaces stale snapshot:', forkText.includes('replaces every earlier agent-rules snapshot'))

const pass = firstText.includes('Answer in concise English.') && firstText.includes('Run pnpm test before claiming done.')
  && again.messages.length === 0 && nextText.includes('EDITED MID SESSION')
  && nextText.includes('Added mid session.') && forkText.includes('replaces every earlier agent-rules snapshot')
console.log(pass ? 'REAL-FS CONTEXT SMOKE: PASS' : 'REAL-FS CONTEXT SMOKE: FAIL')
process.exit(pass ? 0 : 1)
