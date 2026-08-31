import { describe, expect, it } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { makeAgent, makeTree } from './helpers.ts'
import { RULES_SECTION } from '../src/index.ts'

const HOME = '/agents-test-home/.agents'
const PROJECT = '/agents-test-proj'
const NL = String.fromCharCode(10)

function sectionText(prompt: string): string {
  const marker = 'The following agent rules'
  const start = prompt.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  return prompt.slice(start)
}

describe('agents-rules adapter assembly', () => {
  it('injects global and project rules right after the persona section', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Global rule body.')
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/api.md', 'Project rule body.')
    const assembly = await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT + '/sub') })
    expect(assembly.sections.map(section => section.name)).toEqual([
      'harness:identity',
      'deployment:persona',
      RULES_SECTION,
    ])
    const text = sectionText(renderPrompt(assembly))
    expect(text).toContain('style.md')
    expect(text).toContain('Global rule body.')
    expect(text).toContain('Project rule body.')
    expect(text.indexOf('Global rule body.')).toBeLessThan(text.indexOf('Project rule body.'))
  })

  it('freezes the snapshot for the lifetime of one agent', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Original global rule.')
    fs.write(PROJECT + '/.git', '')
    const agent = makeAgent(PROJECT)
    const first = renderPrompt(await ctx.systemPrompt.assemble({ agent }))
    expect(first).toContain('Original global rule.')
    fs.write(HOME + '/rules/style.md', 'EDITED MID-SESSION CONTENT')
    fs.write(HOME + '/rules/added-later.md', 'Added mid-session.')
    const second = renderPrompt(await ctx.systemPrompt.assemble({ agent }))
    expect(second).toBe(first)
    expect(second).not.toContain('EDITED MID-SESSION CONTENT')
  })

  it('reloads for a new agent (new session or fork semantics)', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Original global rule.')
    fs.write(PROJECT + '/.git', '')
    const first = renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) }))
    expect(first).toContain('Original global rule.')
    fs.write(HOME + '/rules/style.md', 'Refreshed content for the next session.')
    const second = renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) }))
    expect(second).toContain('Refreshed content for the next session.')
  })

  it('walks rules directories recursively and ignores non-markdown files', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(PROJECT + '/.git', '')
    fs.write(PROJECT + '/.agents/rules/backend/api.md', 'Nested rule body.')
    fs.write(PROJECT + '/.agents/rules/README.txt', 'ignored non-markdown file')
    const text = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })))
    expect(text).toContain('Nested rule body.')
    expect(text).toContain('.agents/rules/backend/api.md')
    expect(text).not.toContain('ignored non-markdown file')
  })

  it('strips a leading frontmatter block but keeps the body verbatim', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(PROJECT + '/.git', '')
    fs.write(
      PROJECT + '/.agents/rules/meta.md',
      '---' + NL + 'description: machine metadata' + NL + 'anything: else' + NL + '---' + NL + 'Visible rule body.',
    )
    const text = sectionText(renderPrompt(await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })))
    expect(text).toContain('Visible rule body.')
    expect(text).not.toContain('machine metadata')
    expect(text).not.toContain('description')
  })

  it('leaves agentless assemblies untouched', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 65536 })
    fs.write(HOME + '/rules/style.md', 'Global rule body.')
    const assembly = await ctx.systemPrompt.assemble({})
    expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona'])
  })

  it('contributes nothing without an fs provider', async () => {
    const { ctx } = await makeTree({ agentsHome: HOME, maxBytes: 65536, withFs: false })
    const assembly = await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })
    expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona'])
  })

  it('is disabled by a non-positive budget', async () => {
    const { ctx, fs } = await makeTree({ agentsHome: HOME, maxBytes: 0 })
    fs.write(HOME + '/rules/style.md', 'Global rule body.')
    const assembly = await ctx.systemPrompt.assemble({ agent: makeAgent(PROJECT) })
    expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona'])
  })
})
