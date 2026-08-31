/**
 * Shared test fixtures: an in-memory fs provider and adapter tree mounting.
 *
 * @module dsh-agents-rules/tests/helpers
 */

import { dirname, resolve as resolvePath, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ccRules from '../src/index.ts'

const encoder = new TextEncoder()

/** In-memory FileSystem implementation: a path-to-content map with derived directories. */
export class MemoryFs extends FileSystem {
  readonly files = new Map<string, string>()

  /** Store file content under the normalized absolute path. */
  write(path: string, content: string): void {
    this.files.set(this.norm(path), content)
  }

  private norm(path: string): string {
    return resolvePath(path)
  }

  private targetOf(path: string): FsTarget {
    const normalized = this.norm(path)
    return { targetKey: FsTargetKey(normalized), displayPath: normalized }
  }

  /** Every ancestor directory implied by the stored files. */
  private dirs(): Set<string> {
    const set = new Set<string>()
    for (const file of this.files.keys()) {
      let dir = dirname(file)
      for (;;) {
        set.add(dir)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return set
  }

  private info(path: string): FsInfo | undefined {
    const content = this.files.get(path)
    if (content !== undefined) {
      return { version: FsVersion(path), type: 'file', size: encoder.encode(content).length }
    }
    if (this.dirs().has(path)) return { version: FsVersion(path), type: 'directory' }
    return undefined
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.targetOf(resolvePath(opts?.cwd ?? process.cwd(), path))
  }

  override processPath(target: FsTarget): string {
    return target.targetKey as string
  }

  override fileUrl(target: FsTarget): string {
    return 'file://' + this.processPath(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const ancestor = this.processPath(parent)
    const descendant = this.processPath(child)
    return descendant === ancestor || descendant.startsWith(ancestor + sep) || descendant.startsWith(ancestor + '/')
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    return this.info(this.processPath(target))
  }

  override async lstat(path: string, opts?: { cwd?: string }, _signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.info(resolvePath(opts?.cwd ?? process.cwd(), path))
  }

  override async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(this.processPath(target))
    if (content === undefined) throw new Error('not found: ' + this.processPath(target))
    return content
  }

  override async *streamText(target: FsTarget): AsyncIterable<string> {
    yield await this.readText(target)
  }

  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const content = this.files.get(this.processPath(target))
    if (content === undefined) throw new Error('not found: ' + this.processPath(target))
    const bytes = encoder.encode(content)
    if (bytes.length > maxBytes) {
      const error = new Error('FS_TOO_LARGE: target exceeds maxBytes')
      ;(error as { code?: string }).code = 'FS_TOO_LARGE'
      throw error
    }
    return bytes
  }

  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const dir = this.processPath(target)
    const entries = new Map<string, FsDirEntry>()
    for (const [path, content] of this.files) {
      if (!path.startsWith(dir + sep) && !path.startsWith(dir + '/')) continue
      const rel = path.slice(dir.length + 1)
      const nativeCut = rel.indexOf(sep)
      const slashCut = rel.indexOf('/')
      const cut = nativeCut === -1 ? slashCut : slashCut === -1 ? nativeCut : Math.min(nativeCut, slashCut)
      if (cut === -1) {
        entries.set(rel, { name: rel, type: 'file', target: this.targetOf(path), size: encoder.encode(content).length })
      } else {
        const name = rel.slice(0, cut)
        if (!entries.has(name)) entries.set(name, { name, type: 'directory', target: this.targetOf(dir + sep + name) })
      }
    }
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  override async writeText(
    _target: FsTarget,
    _content: string,
    _expected?: FsWriteIntent,
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    throw new Error('unsupported in MemoryFs')
  }

  override async editText(
    _target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: FsVersion },
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    throw new Error('unsupported in MemoryFs')
  }
}

/** A minimal structural agent whose session cwd scopes project rules. */
export function makeAgent(cwd: string, options?: { parentSession?: string; events?: unknown[] }): Agent {
  return {
    session: {
      header: { cwd: resolvePath(cwd), ...options?.parentSession !== undefined ? { parentSession: options.parentSession } : {} },
      events: options?.events ?? [],
      surface: { nodes: new Set<number>((options?.events ?? []).map((e, i) => (e as { seq?: number }).seq ?? i + 1)) },
    },
  } as unknown as Agent
}

export interface TreeOptions {
  readonly mode?: 'context' | 'system-prompt'
  readonly agentsHome: string
  readonly maxBytes: number
  readonly maxFileBytes?: number
  readonly withFs?: boolean
}

/** Boot a minimal real cordis tree: system-prompt service, optional MemoryFs, and the adapter. */
export async function makeTree(options: TreeOptions): Promise<{ ctx: Context; fs: MemoryFs }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You are a test persona.' })
  const fs = options.withFs === false ? new MemoryFs(new Context()) : new MemoryFs(ctx)
  await ctx.plugin(ccRules, {
    mode: options.mode ?? 'system-prompt',
    agentsHome: options.agentsHome,
    maxBytes: options.maxBytes,
    ...options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {},
  })
  return { ctx, fs }
}