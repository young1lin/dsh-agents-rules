/**
 * Config validation: loud failures at plugin load.
 *
 * @module dsh-agents-rules/config
 */

import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { Config, ResolvedConfig } from './types.ts'

/** Default agents home (the tilde expands at resolve time). */
export const DEFAULT_AGENTS_HOME = '~/.agents'

/** Default project-root markers. */
export const DEFAULT_PROJECT_ROOT_MARKERS: readonly string[] = ['.git']

/** Default per-file byte cap. */
export const DEFAULT_MAX_FILE_BYTES = 262144

/** Platform path separators, built without escape sequences. */
const SLASH = '/'
const BACKSLASH = String.fromCharCode(92)

/**
 * Expand a leading '~' or '~'+separator prefix against the OS home directory.
 * @param path - a configured path, possibly '~'-prefixed.
 * @returns the expanded path.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~' + BACKSLASH)) return homedir() + path.slice(1)
  return path
}

/**
 * Collapse the OS home prefix to '~' and normalize separators to '/' for
 * model-visible display.
 * @param absolute - an absolute path.
 * @returns '~'-prefixed display form when under the OS home, else the input
 *   with separators normalized to '/'.
 */
function tildeForDisplay(absolute: string): string {
  const home = homedir()
  if (absolute === home) return '~'
  const withSlash = home + SLASH
  if (absolute.startsWith(withSlash)) {
    return '~' + absolute.slice(home.length)
  }
  const withBackslash = home + BACKSLASH
  if (absolute.startsWith(withBackslash)) {
    return ('~' + absolute.slice(home.length)).replaceAll(BACKSLASH, SLASH)
  }
  return absolute.replaceAll(BACKSLASH, SLASH)
}

/**
 * Validate and default the plugin config, failing loud on self-contained
 * misconfiguration.
 * @param config - the raw cordis row config.
 * @returns the frozen resolved config.
 * @throws when maxBytes is not a finite number, maxFileBytes is not a positive
 *   integer, agentsHome does not expand to an absolute path, or a project-root
 *   marker is not a bare file name.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (typeof config.maxBytes !== 'number' || !Number.isFinite(config.maxBytes)) {
    throw new Error('agents-rules: config.maxBytes must be a finite number')
  }
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('agents-rules: config.maxFileBytes must be a positive integer')
  }
  const agentsHome = expandHome(config.agentsHome ?? DEFAULT_AGENTS_HOME)
  if (agentsHome.length === 0 || !isAbsolute(agentsHome)) {
    throw new Error(
      'agents-rules: config.agentsHome must expand to an absolute path (got ' + JSON.stringify(config.agentsHome) + ')',
    )
  }
  const markers = config.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS
  for (const marker of markers) {
    if (marker.length === 0 || marker === '.' || marker === '..' || marker.includes(SLASH) || marker.includes(BACKSLASH)) {
      throw new Error(
        'agents-rules: config.projectRootMarkers entries must be bare file names (got ' + JSON.stringify(marker) + ')',
      )
    }
  }
  return Object.freeze({
    agentsHome,
    agentsHomeDisplay: tildeForDisplay(agentsHome),
    projectRootMarkers: markers,
    maxBytes: config.maxBytes,
    maxFileBytes,
  })
}
