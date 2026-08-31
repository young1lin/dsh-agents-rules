/**
 * Leading YAML frontmatter stripping for rule files.
 *
 * The .agents/rules convention has no documented frontmatter field semantics,
 * so no field is interpreted; a leading metadata block is machine data and is
 * dropped so only prose reaches the model.
 *
 * @module dsh-agents-rules/frontmatter
 */

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const CRLF = CR + LF

/**
 * Drop a leading YAML frontmatter block (a first line of '---' closed by a
 * later '---' line) and return the body.
 *
 * A block that never closes is not frontmatter; the complete text returns
 * unchanged. Line endings normalize to LF in the returned body.
 *
 * @param content - the complete rule-file text.
 * @returns the body after the closing delimiter, or the input when no complete
 *   leading block exists.
 */
export function stripFrontmatterBlock(content: string): string {
  const lines = content.split(CRLF).join(LF).split(LF)
  if ((lines[0] ?? '').trimEnd() !== '---') return content
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trimEnd() === '---') return lines.slice(i + 1).join(LF)
  }
  return content
}
