import { describe, expect, it } from 'vitest'
import { renderRulesSection, SECTION_INTRO } from '../src/render.ts'
import type { RuleFile } from '../src/types.ts'

const encoder = new TextEncoder()
const NL = String.fromCharCode(10)

function rule(origin: 'global' | 'project', relPath: string, content: string): RuleFile {
  return { origin, relPath, displayPath: (origin === 'global' ? '~/.agents/rules' : '.agents/rules') + '/' + relPath, content }
}

describe('renderRulesSection', () => {
  it('renders global before project in per-file rule elements', () => {
    const text = renderRulesSection(
      [
        rule('global', 'style.md', 'Global body.'),
        rule('project', 'api.md', 'Project body.'),
      ],
      65536,
      [],
    )
    expect(text).toContain(SECTION_INTRO)
    expect(text.indexOf('~/.agents/rules/style.md')).toBeLessThan(text.indexOf('.agents/rules/api.md'))
    expect(text).toContain('<rule origin="global" path="~/.agents/rules/style.md">')
    expect(text).toContain('<rule origin="project" path=".agents/rules/api.md">')
    expect(text).toContain('Global body.')
    expect(text).toContain('Project body.')
  })

  it('strips a leading frontmatter block from injected content', () => {
    const text = renderRulesSection(
      [rule('project', 'meta.md', '---' + NL + 'x: y' + NL + '---' + NL + 'Visible body.')],
      65536,
      [],
    )
    expect(text).toContain('Visible body.')
    expect(text).not.toContain('x: y')
  })

  it('returns empty when nothing applies', () => {
    expect(renderRulesSection([], 65536, [])).toBe('')
    expect(renderRulesSection([rule('project', 'blank.md', '---' + NL + 'x: y' + NL + '---' + NL + '')], 65536, [])).toBe('')
  })

  it('drops whole broad files first and records them when over budget', () => {
    const big = 'G'.repeat(400)
    const text = renderRulesSection(
      [rule('global', 'big.md', big), rule('project', 'small.md', 'Small body.')],
      480,
      [],
    )
    expect(encoder.encode(text).length).toBeLessThanOrEqual(480)
    expect(text).toContain('Small body.')
    expect(text).toContain('Rule files omitted to fit the section budget: ~/.agents/rules/big.md')
  })

  it('truncates with a visible marker when a single file exceeds the budget', () => {
    const huge = 'H'.repeat(5000)
    const text = renderRulesSection([rule('project', 'huge.md', huge)], 300, [])
    expect(encoder.encode(text).length).toBeLessThanOrEqual(300)
    expect(text).toContain('[Section truncated to fit the configured budget.]')
  })

  it('lists oversized files as a note', () => {
    const text = renderRulesSection([rule('global', 'ok.md', 'OK body.')], 65536, ['~/.agents/rules/huge.md'])
    expect(text).toContain('Rule files skipped for exceeding the per-file size cap: ~/.agents/rules/huge.md')
    expect(text).toContain('OK body.')
  })

  it('renders identical content once and records the skipped duplicate', () => {
    const text = renderRulesSection(
      [
        rule('global', 'style.md', 'Shared body.'),
        { origin: 'global', relPath: 'style.md', displayPath: '~/.claude/rules/style.md', content: 'Shared body.' },
      ],
      65536,
      [],
    )
    expect(text.match(/Shared body\./g)?.length).toBe(1)
    expect(text).toContain('path="~/.agents/rules/style.md"')
    expect(text).toContain('Rule files skipped as exact duplicates of an earlier rule file: ~/.claude/rules/style.md (= ~/.agents/rules/style.md)')
  })

  it('dedupes on the prepared body, ignoring differing frontmatter', () => {
    const text = renderRulesSection(
      [
        rule('global', 'a.md', 'Shared body.'),
        { origin: 'project', relPath: 'b.md', displayPath: '.claude/rules/b.md', content: '---' + NL + 'x: 1' + NL + '---' + NL + 'Shared body.' },
      ],
      65536,
      [],
    )
    expect(text.match(/Shared body\./g)?.length).toBe(1)
  })

  it('keeps both copies when the same path holds different content', () => {
    const text = renderRulesSection(
      [
        rule('global', 'style.md', 'Canonical body.'),
        { origin: 'global', relPath: 'style.md', displayPath: '~/.claude/rules/style.md', content: 'Compat body.' },
      ],
      65536,
      [],
    )
    expect(text).toContain('Canonical body.')
    expect(text).toContain('Compat body.')
    expect(text).not.toContain('exact duplicates')
  })
})