/**
 * Snapshot rendering: frontmatter stripping, byte budget, and the model-visible
 * snapshot text for both delivery modes.
 *
 * Per-file framing uses an XML-style element carrying origin and path, so rule
 * content keeps its own markdown headings untouched — a frame built from
 * markdown headings would invert against file content that starts at '#'.
 *
 * @module dsh-agents-rules/render
 */

import { stripFrontmatterBlock } from './frontmatter.ts'
import type { RuleFile } from './types.ts'

/** Intro line of the rendered section (pinned model-visible text). */
export const SECTION_INTRO =
  'The following agent rules were loaded once at session start and are frozen for this session. ' +
  'Use them as guidance when applicable. They do not override system, developer, or direct user instructions.'

/** Truncation marker appended when the budget still overflows after whole-file drops. */
const TRUNCATION_MARKER = '[Section truncated to fit the configured budget.]'

/** A rule selected for injection with its prepared content. */
interface SelectedRule {
  readonly file: RuleFile
  readonly content: string
}

/** The Unicode replacement character, built without an escape sequence. */
const REPLACEMENT = String.fromCharCode(65533)

/** Literal that must not appear inside rule content: it would close the per-file element. */
const RULE_CLOSER = '</rule>'

const encoder = new TextEncoder()

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Truncate to at most maxBytes UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  const partial = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, Math.max(0, maxBytes)))
  return partial.endsWith(REPLACEMENT) ? partial.slice(0, -1) : partial
}

/** Escape attribute-breaking characters in a path. */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

/** Neutralize a closing-tag literal inside rule content. */
function escapeRuleCloser(text: string): string {
  return text.replaceAll(RULE_CLOSER, '&lt;/rule&gt;')
}

/** One framed rule element: opening tag, blank line, content, closing tag. */
function ruleElement(rule: SelectedRule): string {
  return '<rule origin="' + escapeAttribute(rule.file.origin) + '" path="' + escapeAttribute(rule.file.displayPath) + '">'
    + String.fromCharCode(10, 10)
    + escapeRuleCloser(rule.content)
    + String.fromCharCode(10)
    + RULE_CLOSER
}

/** Compose intro (optional), rule elements in given order, and notes. */
function compose(rules: readonly SelectedRule[], notes: readonly string[], withIntro: boolean): string {
  const NLNL = String.fromCharCode(10, 10)
  const parts: string[] = withIntro ? [SECTION_INTRO] : []
  for (const rule of rules) parts.push(ruleElement(rule))
  if (notes.length > 0) parts.push(notes.map(note => '- ' + note).join(String.fromCharCode(10)))
  return parts.join(NLNL)
}

/**
 * Render the complete rules section with the standing intro line.
 *
 * Every discovered file injects verbatim after stripping a leading frontmatter
 * block; files whose prepared content is identical to an earlier file's render
 * once, with the skipped copy listed in a closing note. The total byte budget
 * applies to the complete section: whole files drop from the broad (global)
 * end while dropping reduces the size, then the remainder truncates with a
 * visible marker.
 *
 * @param files - discovered files, broadest-first (global roots before project).
 * @param maxBytes - total byte budget for the complete section.
 * @param oversized - display paths skipped for exceeding the per-file cap.
 * @returns the section text, or an empty string when no rule and no note exists.
 */
export function renderRulesSection(
  files: readonly RuleFile[],
  maxBytes: number,
  oversized: readonly string[],
): string {
  return renderSnapshot(files, maxBytes, oversized, true)
}

/**
 * The same snapshot without the standing intro line, for context-mode frames
 * that carry their own opening sentence. Content-level deduplication applies
 * exactly as in renderRulesSection.
 *
 * @param files - discovered files, broadest-first (global roots before project).
 * @param maxBytes - total byte budget for the complete body.
 * @param oversized - display paths skipped for exceeding the per-file cap.
 * @returns the body text, or an empty string when no rule and no note exists.
 */
export function renderRulesBody(
  files: readonly RuleFile[],
  maxBytes: number,
  oversized: readonly string[],
): string {
  return renderSnapshot(files, maxBytes, oversized, false)
}

/** Shared renderer backing both delivery modes. */
function renderSnapshot(
  files: readonly RuleFile[],
  maxBytes: number,
  oversized: readonly string[],
  withIntro: boolean,
): string {
  // Content-level dedup: rule sets mirrored across conventions (or scopes)
  // would inject the same prose twice. The first occurrence wins — roots are
  // broad-to-specific with the canonical .agents convention ahead of the
  // .claude compat root — and every skipped copy is recorded below.
  const selected: SelectedRule[] = []
  const duplicates: string[] = []
  const keptPathByContent = new Map<string, string>()
  for (const file of files) {
    const content = stripFrontmatterBlock(file.content).trim()
    if (content.length === 0) continue
    const keptPath = keptPathByContent.get(content)
    if (keptPath !== undefined) {
      duplicates.push(file.displayPath + ' (= ' + keptPath + ')')
      continue
    }
    keptPathByContent.set(content, file.displayPath)
    selected.push({ file, content })
  }
  if (selected.length === 0 && oversized.length === 0) return ''

  const fixedNotes: string[] = []
  if (oversized.length > 0) {
    fixedNotes.push('Rule files skipped for exceeding the per-file size cap: ' + oversized.join('; '))
  }
  if (duplicates.length > 0) {
    fixedNotes.push('Rule files skipped as exact duplicates of an earlier rule file: ' + duplicates.join('; '))
  }

  const NLNL = String.fromCharCode(10, 10)
  let kept = selected
  let text = compose(kept, fixedNotes, withIntro)
  while (byteLength(text) > maxBytes && kept.length > 1) {
    const droppedCount = selected.length - kept.length + 1
    const dropped = selected.slice(0, droppedCount).map(rule => rule.file.displayPath)
    const candidateKept = kept.slice(1)
    const notes = [...fixedNotes, 'Rule files omitted to fit the section budget: ' + dropped.join('; ')]
    const candidate = compose(candidateKept, notes, withIntro)
    if (byteLength(candidate) >= byteLength(text)) break
    kept = candidateKept
    text = candidate
  }
  if (byteLength(text) > maxBytes) {
    const marker = NLNL + TRUNCATION_MARKER
    const room = maxBytes - byteLength(marker)
    text = room > 0 ? truncateUtf8(text, room) + marker : truncateUtf8(text, maxBytes)
  }
  return text
}
