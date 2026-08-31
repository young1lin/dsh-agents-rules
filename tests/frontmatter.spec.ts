import { describe, expect, it } from 'vitest'
import { stripFrontmatterBlock } from '../src/frontmatter.ts'

const LF = String.fromCharCode(10)

describe('stripFrontmatterBlock', () => {
  it('drops a complete leading block and returns the body', () => {
    const content = '---' + LF + 'description: meta' + LF + '---' + LF + 'Visible body.'
    expect(stripFrontmatterBlock(content)).toBe('Visible body.')
  })

  it('returns the input unchanged when no leading block exists', () => {
    const content = 'Just rule text.'
    expect(stripFrontmatterBlock(content)).toBe(content)
  })

  it('treats an unclosed block as ordinary content', () => {
    const content = '---' + LF + 'description: meta' + LF + 'Body without close.'
    expect(stripFrontmatterBlock(content)).toBe(content)
  })

  it('normalizes CRLF line endings in the returned body', () => {
    const CRLF = String.fromCharCode(13, 10)
    const content = '---' + CRLF + 'description: meta' + CRLF + '---' + CRLF + 'Visible body.'
    expect(stripFrontmatterBlock(content)).toBe('Visible body.')
  })

  it('keeps later --- lines in the body', () => {
    const content = '---' + LF + 'a: b' + LF + '---' + LF + 'Before' + LF + '---' + LF + 'After'
    expect(stripFrontmatterBlock(content)).toBe('Before' + LF + '---' + LF + 'After')
  })
})
