/**
 * Manual smoke for scope handling of the rules section. Self-contained:
 * plants a throwaway project fixture under the OS temp dir. Override the
 * project root with DSH_RULES_SMOKE_PROJ to smoke a real checkout.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as rules from '../lib/index.js'

const planted = !process.env.DSH_RULES_SMOKE_PROJ
const root = planted ? mkdtempSync(join(tmpdir(), 'dsh-agents-rules-scope-')) : ''
const PROJ = process.env.DSH_RULES_SMOKE_PROJ ?? join(root, 'proj')
if (planted) {
  const dir = join(PROJ, '.agents', 'rules')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scope-rule.md'), 'Prefer small pure helpers in tests.')
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, { persona: 'P.' })
new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 })
await ctx.plugin(rules, { mode: 'system-prompt', maxBytes: 65536 })

const agent = { id: 'scope-test', session: { header: { cwd: PROJ } } }

// A) no scope (plain assembly)
const a = await ctx.systemPrompt.assemble({ agent })
console.log('no-scope sections:', a.sections.map(s => s.name).join(','))

// B) scope set to an opaque key (production pattern: scope = agent object)
const scopeKey = {}
createScope(ctx, scopeKey)
const b = await ctx.systemPrompt.assemble({ agent, scope: scopeKey })
console.log('scoped sections:  ', b.sections.map(s => s.name).join(','))

const c = await ctx.systemPrompt.assemble({ agent, scope: agent })
console.log('agent-as-scope:   ', c.sections.map(s => s.name).join(','))

// sanity: the planted rule actually renders in the scoped assembly
const cText = renderPrompt(c)
console.log('planted rule rendered:', cText.includes('Prefer small pure helpers in tests.'))

const ok = b.sections.some(s => s.name === 'agents-rules:rules') && c.sections.some(s => s.name === 'agents-rules:rules')
  && (!planted || cText.includes('Prefer small pure helpers in tests.'))
console.log(ok ? 'SCOPE TEST: PASS (rules present under scope)' : 'SCOPE TEST: FAIL (rules missing under scope)')
process.exit(ok ? 0 : 1)
