# Changelog

## 0.2.0 — 2026-08-31

Initial public release.

- Loads `*.md` rule files from the vendor-neutral `.agents/rules` convention — project (`<projectRoot>/.agents/rules`) and global (`~/.agents/rules`) — discovered recursively in stable name order; global rules render before project rules.
- Snapshot frozen per session: the first system-prompt assembly reads the rule files once; every later assembly of the same session reuses the cached section. New sessions, forks, and resumed sessions read the current files again.
- Two delivery modes: `context` (default — one durable user-role message through the `agent/pre-step` waterfall) and `system-prompt` (one section per assembly, prefix-stable within a session).
- Byte budgets (`maxBytes`, `maxFileBytes`): whole files drop from the broad end first with recorded notes; an oversized single file truncates with a visible marker; misconfiguration fails loud at plugin load.
- Degrades safely without an fs provider; reads are bounded and cancellation-safe.
- Ships as a DSH bundle (`cordis.patch.yml`). Config: `mode`, `agentsHome`, `projectRootMarkers`, `maxBytes`, `maxFileBytes`.
