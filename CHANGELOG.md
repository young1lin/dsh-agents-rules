# Changelog

## 0.3.1 — 2026-10-01

DSH 0.2 compatibility and package metadata fixes.

- Update DSH peer dependencies and the development lockfile to `0.2.0-rc.2`; rule discovery, deduplication, and session snapshot behavior are unchanged.
- Preserve downstream enter-decision metadata, including `startsRequestSeries`, when injecting or replacing context rules, so DSH model-message series boundaries remain intact.
- Align the Cordis peer floor with the DSH `0.2.0-rc.2` requirement (`4.0.4`).
- Correct both TypeScript declaration entry points to the actual build output, `lib/index.d.ts`, so package consumers can resolve the plugin types.
- Allow the exact newly published DSH dependency versions through pnpm's release-age gate while keeping the default protection for other packages.

## 0.3.0 — 2026-09-29

Claude Code compatibility and content-level deduplication.

- Loads `*.md` rule files from the Claude Code convention too, at both scopes: global `~/.claude/rules` and project `<projectRoot>/.claude/rules`. Root order is global `.agents` → global `.claude` → project `.agents` → project `.claude` (broad to specific, canonical convention first). Disable with `claudeCompat: false`; relocate the global directory with `claudeHome` (default `~/.claude`, validated like `agentsHome`).
- Deduplication: files whose prepared content (frontmatter stripped) is identical to an earlier file's render exactly once — the first occurrence wins, so a `.agents` copy beats its `.claude` mirror. Skipped copies are listed in a closing note (`Rule files skipped as exact duplicates of an earlier rule file: ...`). Same-path files with diverged content both stay.
- `.claude/rules` frontmatter condition fields (`paths`, `always`, ...) are not interpreted, matching the plugin's no-field-interpretation stance; every discovered file injects unconditionally.
- Raised the DSH peer floor to `^0.1.7-rc.2` and migrated to the current APIs: session-history reads go through `Session.snapshotEvents()` (the event log became private in dsh 0.1.5), and the rules system-prompt section now splices after `deployment:persona-prefix` (`PERSONA_SECTION` split into prefix/suffix sections).
- Added an environment-independent integration suite (`tests/integration.spec.ts`, runs in `pnpm test`): four-root composition with dedup, budget drops, the per-file cap, the full context-mode lifecycle (freeze → reload → fork replace), scoped assembly, marker walk-up and the no-marker cwd fallback — all on the in-memory fs, no temp dirs, real home, or symlinks required.

## 0.2.0 — 2026-08-31

Initial public release.

- Loads `*.md` rule files from the vendor-neutral `.agents/rules` convention — project (`<projectRoot>/.agents/rules`) and global (`~/.agents/rules`) — discovered recursively in stable name order; global rules render before project rules.
- Snapshot frozen per session: the first system-prompt assembly reads the rule files once; every later assembly of the same session reuses the cached section. New sessions, forks, and resumed sessions read the current files again.
- Two delivery modes: `context` (default — one durable user-role message through the `agent/pre-step` waterfall) and `system-prompt` (one section per assembly, prefix-stable within a session).
- Byte budgets (`maxBytes`, `maxFileBytes`): whole files drop from the broad end first with recorded notes; an oversized single file truncates with a visible marker; misconfiguration fails loud at plugin load.
- Degrades safely without an fs provider; reads are bounded and cancellation-safe.
- Ships as a DSH bundle (`cordis.patch.yml`). Config: `mode`, `agentsHome`, `projectRootMarkers`, `maxBytes`, `maxFileBytes`.
