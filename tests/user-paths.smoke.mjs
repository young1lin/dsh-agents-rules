/**
 * Manual smoke on real-filesystem path resolution (default home + project
 * root walking) and the Claude compat roots. Self-contained by default:
 * plants throwaway HOME/PROJ fixtures under the OS temp dir. To smoke against
 * your own machine instead, set DSH_RULES_SMOKE_PROJ (and optionally
 * DSH_RULES_SMOKE_HOME) to real directories; in that mode the adapter's
 * default agentsHome (~/.agents) and claudeHome (~/.claude) are used, exactly
 * like a live deployment.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as agentsRules from '../lib/index.js'

const planted = !process.env.DSH_RULES_SMOKE_PROJ
const root = planted ? mkdtempSync(join(tmpdir(), 'dsh-agents-rules-userpaths-')) : ''
const HOME = process.env.DSH_RULES_SMOKE_HOME ?? join(root, 'home')
const PROJ = process.env.DSH_RULES_SMOKE_PROJ ?? join(root, 'proj')
const plant = (base, dirName, name, body) => {
  const dir = join(base, dirName, 'rules')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}
if (planted) {
  plant(HOME, '.agents', 'global-style.md', 'Answer in concise English; write code comments in English.')
  plant(HOME, '.claude', 'claude-global-english.md', 'Prefer exact error messages over generic ones.')
  plant(PROJ, '.agents', 'db-transactions.md', 'Avoid implicit transaction pitfalls.')
  plant(PROJ, '.agents', 'cache.md', 'Warm the redis config cache on boot.')
  plant(PROJ, '.agents', 'ids.md', 'Serialize snowflake ids as strings.')
  // mirrored into the compat convention: must dedupe against the .agents copy
  plant(PROJ, '.claude', 'ids.md', 'Serialize snowflake ids as strings.')
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, { persona: 'P.' })
new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 })
await ctx.plugin(agentsRules, planted
  ? { mode: 'system-prompt', maxBytes: 65536, agentsHome: join(HOME, '.agents'), claudeHome: join(HOME, '.claude') }
  : { mode: 'system-prompt', maxBytes: 65536 })  // defaults: ~/.agents + ~/.claude

const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: { session: { header: { cwd: PROJ } } } }))
const has = (s) => prompt.includes(s)
console.log('rules section present:', has('The following agent rules'))
console.log('global (planted global-style):', has('global-style.md'))
console.log('claude global (planted claude-global-english):', has('claude-global-english.md'))
console.log('project rule filenames loaded:', has('db-transactions.md') && has('cache.md') && has('ids.md'))
const i = prompt.indexOf('origin="global"')
const j = prompt.indexOf('origin="project"')
console.log('global before project:', i >= 0 && j > i)
const snowflakeCount = (prompt.match(/Serialize snowflake ids as strings\./g) || []).length
console.log('mirrored .claude copy deduped:', !planted || snowflakeCount === 1)
console.log('duplicate note present:', !planted
  || (has('Rule files skipped as exact duplicates of an earlier rule file')
    && has('.claude/rules/ids.md (= .agents/rules/ids.md)')))
const pass = has('The following agent rules')
  && (!planted || (has('global-style.md') && has('claude-global-english.md') && has('db-transactions.md')
    && has('cache.md') && has('ids.md')))
  && i >= 0 && j > i
  && (!planted || (snowflakeCount === 1 && has('.claude/rules/ids.md (= .agents/rules/ids.md)')))
console.log(pass ? 'USER-PATHS TEST: PASS' : 'USER-PATHS TEST: FAIL')
process.exit(pass ? 0 : 1)
