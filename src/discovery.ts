/**
 * Rule-file discovery over the fs capability: project-root walk plus recursive
 * rules-directory traversal with bounded reads.
 *
 * @module dsh-agents-rules/discovery
 */

import { dirname, join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { RuleFile, RuleOrigin } from './types.ts'

/** One rules root to walk. */
export interface RulesRoot {
  /** Origin recorded on every file found under this root. */
  readonly origin: RuleOrigin
  /** Absolute directory path. */
  readonly dir: string
  /** Display prefix for model-visible headings, '/'-separated. */
  readonly displayRoot: string
}

/** Collected files plus budget skips from one discovery pass. */
export interface DiscoveryResult {
  /** Discovered rule files in deterministic walk order, roots in the given order. */
  readonly files: RuleFile[]
  /** Display paths of files skipped for exceeding the per-file byte cap. */
  readonly oversized: string[]
}

/** Diagnostic sink for provider failures; unused for confirmed absences. */
export type Warn = (message: string, error: unknown) => void

/** Mutable accumulator shared by the recursive walk. */
interface WalkState {
  files: RuleFile[]
  oversized: string[]
}

/** Lowercase .md suffix test. */
function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

/** Compare entries by name with UTF-16 code units: locale-independent, stable everywhere. */
function compareNames(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Whether an error reports the per-file byte cap rather than a provider failure. */
function isTooLarge(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'FS_TOO_LARGE' || (error instanceof Error && error.message.includes('TOO_LARGE'))
}

/** Model-visible path of one walked file. */
function displayPath(root: RulesRoot, relPath: string): string {
  return root.displayRoot + '/' + relPath
}

/** Strict UTF-8 decoder: invalid byte sequences reject instead of replacing. */
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Walk up from cwd until a directory contains one of the markers; the session
 * cwd itself is the fallback root.
 * @param fs - the fs capability provider.
 * @param cwd - absolute session working directory.
 * @param markers - bare marker file names.
 * @param signal - aborts the walk.
 * @returns the first ancestor (or cwd itself) containing a marker.
 */
export async function findProjectRoot(
  fs: FileSystem,
  cwd: string,
  markers: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  let dir = cwd
  for (;;) {
    for (const marker of markers) {
      signal?.throwIfAborted()
      const info = await fs.lstat(join(dir, marker))
      if (info !== undefined) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

/**
 * Recursively collect .md files under one resolved directory target.
 *
 * Children visit in name order (directories and files interleaved), so the
 * complete walk order is deterministic across machines.
 */
async function walk(
  fs: FileSystem,
  root: RulesRoot,
  target: FsTarget,
  prefix: string,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
  warn: Warn,
  state: WalkState,
): Promise<void> {
  const entries = (await fs.listDir(target, signal)).slice().sort(compareNames)
  for (const entry of entries) {
    signal?.throwIfAborted()
    const relPath = prefix.length === 0 ? entry.name : prefix + '/' + entry.name
    if (entry.type === 'directory') {
      await walk(fs, root, entry.target, relPath, maxFileBytes, signal, warn, state)
      continue
    }
    if (entry.type !== 'file' || !isMarkdown(entry.name)) continue
    if (entry.size !== undefined && entry.size > maxFileBytes) {
      state.oversized.push(displayPath(root, relPath))
      continue
    }
    try {
      const bytes = await fs.readBytes(entry.target, signal, maxFileBytes)
      const content = strictDecoder.decode(bytes)
      state.files.push({ origin: root.origin, relPath, displayPath: displayPath(root, relPath), content })
    } catch (error) {
      if (isTooLarge(error)) {
        state.oversized.push(displayPath(root, relPath))
        continue
      }
      warn('agents-rules: failed to read rule file ' + displayPath(root, relPath), error)
    }
  }
}

/**
 * Collect rule files under each root, in the given root order.
 *
 * An absent root contributes nothing silently; a root whose metadata probe or
 * resolution fails is reported through warn and skipped for this pass.
 *
 * @param fs - the fs capability provider.
 * @param roots - rules roots in broad-to-specific order.
 * @param maxFileBytes - per-file byte cap enforced by the bounded read.
 * @param signal - aborts discovery.
 * @param warn - diagnostic sink for provider failures.
 * @returns discovered files and oversized display paths.
 */
export async function collectRules(
  fs: FileSystem,
  roots: readonly RulesRoot[],
  maxFileBytes: number,
  signal: AbortSignal | undefined,
  warn: Warn,
): Promise<DiscoveryResult> {
  const state: WalkState = { files: [], oversized: [] }
  for (const root of roots) {
    signal?.throwIfAborted()
    let info
    try {
      info = await fs.lstat(root.dir)
    } catch (error) {
      warn('agents-rules: rules directory ' + root.dir + ' is temporarily unavailable', error)
      continue
    }
    if (info === undefined || info.type === 'other') continue
    let target: FsTarget
    try {
      target = await fs.resolve(root.dir)
    } catch (error) {
      warn('agents-rules: rules directory ' + root.dir + ' is temporarily unavailable', error)
      continue
    }
    await walk(fs, root, target, '', maxFileBytes, signal, warn, state)
  }
  return state
}
