/**
 * Shared types for the AGENTS rules adapter.
 *
 * @module dsh-agents-rules/types
 */

/** Plugin configuration (the cordis row config). */
export interface Config {
  /**
   * Delivery mode: 'context' publishes a durable user-role message (visible in
   * the conversation, like the skill catalog); 'system-prompt' splices one
   * section into each assembly. Default 'context'.
   */
  mode?: 'context' | 'system-prompt'
  /**
   * Home directory holding the global rules; a leading tilde expands against
   * the OS home. Global rules load from <agentsHome>/rules. Default '~/.agents'.
   */
  agentsHome?: string
  /**
   * Claude Code compatibility: also load rule files from ~/.claude/rules
   * (global) and <projectRoot>/.claude/rules (project) alongside the .agents
   * convention, deduplicated by content. Default true.
   */
  claudeCompat?: boolean
  /**
   * Home directory holding the global Claude rules (<claudeHome>/rules); a
   * leading tilde expands against the OS home. Default '~/.claude'. Only read
   * when claudeCompat is true.
   */
  claudeHome?: string
  /**
   * Same-directory marker names that identify the project root when walking up
   * from the session cwd. Default ['.git']. Entries must be bare file names.
   */
  projectRootMarkers?: string[]
  /**
   * Total byte budget for the complete rendered rules section. Required so each
   * deployment makes its prompt-budget choice explicitly. Non-positive or
   * non-finite disables rule injection.
   */
  maxBytes: number
  /**
   * Per-file byte cap; an oversized rule file is skipped with a notice instead
   * of read. Default 262144.
   */
  maxFileBytes?: number
}

/** Validated, frozen plugin configuration. */
export interface ResolvedConfig {
  /** Absolute tilde-expanded agents home. */
  readonly agentsHome: string
  /** Model-visible form of agentsHome ('~'-collapsed when under the OS home). */
  readonly agentsHomeDisplay: string
  /** Whether the Claude Code .claude/rules convention also loads. */
  readonly claudeCompat: boolean
  /** Absolute tilde-expanded Claude home. */
  readonly claudeHome: string
  /** Model-visible form of claudeHome ('~'-collapsed when under the OS home). */
  readonly claudeHomeDisplay: string
  /** Validated project-root marker names. */
  readonly projectRootMarkers: readonly string[]
  /** Total section byte budget; non-positive disables injection. */
  readonly maxBytes: number
  /** Positive per-file byte cap. */
  readonly maxFileBytes: number
}

/** Origin of one discovered rule file. */
export type RuleOrigin = 'global' | 'project'

/** One discovered rule file with its model-visible display path. */
export interface RuleFile {
  /** Whether the file came from the agents home or the project root. */
  readonly origin: RuleOrigin
  /** Rule-file path relative to its rules root, '/'-separated. */
  readonly relPath: string
  /** Model-visible path shown as the content's heading. */
  readonly displayPath: string
  /** Complete file content, frontmatter included. */
  readonly content: string
}