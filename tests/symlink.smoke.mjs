/**
 * Manual smoke for symlink traversal during rule discovery: a project whose
 * .agents/rules is itself a link to a real directory, containing a nested
 * subdir plus a file symlink. Self-contained under the OS temp dir.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as agentsRules from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-agents-rules-symlink-'))
const PROJ = join(root, 'proj')
const rulesRoot = join(root, 'rules-root')
const agentsHome = join(root, 'none-home')  // empty home: project rules only

mkdirSync(join(rulesRoot, 'nested'), { recursive: true })
mkdirSync(join(PROJ, '.agents'), { recursive: true })
mkdirSync(agentsHome, { recursive: true })
writeFileSync(join(rulesRoot, 'rule-a.md'), 'Rule A: avoid implicit transaction traps.')
writeFileSync(join(rulesRoot, 'rule-b.md'), 'Rule B: serialize snowflake ids as strings.')
writeFileSync(join(rulesRoot, 'nested', 'nested.md'), 'Rule C: nested rule.')

// the project rules directory is a symlink (junction on Windows) to the root
const rulesLink = join(PROJ, '.agents', 'rules')
try {
  symlinkSync(rulesRoot, rulesLink, 'dir')
} catch {
  symlinkSync(rulesRoot, rulesLink, 'junction')  // Windows without symlink privilege
}

// plus a symlinked file child inside the linked root
let aliasOk = true
try {
  symlinkSync(join(rulesRoot, 'nested', 'nested.md'), join(rulesRoot, 'alias.md'), 'file')
} catch {
  aliasOk = false
  console.log('note: file symlink unavailable (developer mode / admin needed on Windows) — alias check relaxed')
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, { personaPrefix: 'P.' })
new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 })
await ctx.plugin(agentsRules, { mode: 'system-prompt', agentsHome, claudeCompat: false, maxBytes: 65536 })

const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: { session: { header: { cwd: PROJ } } } }))
const has = (s) => prompt.includes(s)
console.log('rules section present:', has('The following agent rules'))
console.log('rule A (linked root, file 1):', has('Rule A: avoid implicit transaction traps.'))
console.log('rule B (linked root, file 2):', has('Rule B: serialize snowflake ids as strings.'))
console.log('rule C (nested subdir):', has('Rule C: nested rule.'))
const ruleCCount = (prompt.match(/Rule C/g) || []).length
// the symlinked file alias carries identical content: content-level dedup
// collapses it to one element and records the skipped copy in a note
// (alias.md sorts before nested/, so it is the kept canonical copy)
const deduped = !aliasOk || (ruleCCount === 1
  && has('Rule files skipped as exact duplicates of an earlier rule file')
  && has('.agents/rules/nested/nested.md (= .agents/rules/alias.md)'))
console.log('symlinked file alias deduped:', deduped)
const pass = has('The following agent rules') && has('Rule A: avoid implicit transaction traps.')
  && has('Rule B: serialize snowflake ids as strings.') && has('Rule C: nested rule.')
  && ruleCCount === 1 && deduped
console.log(pass ? 'SYMLINK TEST: PASS' : 'SYMLINK TEST: FAIL')
process.exit(pass ? 0 : 1)
