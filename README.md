# dsh-agents-rules

English | [中文](README.zh.md)

An AGENTS rules adapter plugin (bundle) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It loads rule files from the vendor-neutral `.agents/rules` convention — project (`<projectRoot>/.agents/rules`) and global (`~/.agents/rules`) — and injects them into the system prompt as one section.

## Why this shape

Coding-agent rule conventions load their rule files once at session start and never refresh them mid-conversation: a rule added while a session is running is invisible to that session, and only a new conversation (or a fork) picks it up. This adapter reproduces exactly that semantic on DSH:

- The first system-prompt assembly of a session reads the rule files once and caches the rendered section keyed by the session's live agent.
- Every later assembly of the same session reuses the cached text — mid-session edits, additions, and deletions never enter an existing conversation.
- A new session, a fork, or a resumed session is a new agent, so it reads the current files again.

Two delivery modes (`mode` config): `context` (default) publishes one durable user-role message framed like the skill catalog — visible in the conversation, reconstructable from the session log, injected through the `agent/pre-step` waterfall without patching the agent loop. `system-prompt` splices one section into each assembly instead (prefix-stable across a session).

## What is loaded

- **Global rules**: every `*.md` file under `<agentsHome>/rules` (default `~/.agents/rules`), discovered recursively in stable name order.
- **Project rules**: every `*.md` file under `<projectRoot>/.agents/rules`, where the project root is the nearest ancestor of the session cwd containing a project-root marker (default `.git`; the session cwd itself is the fallback). When no marker exists up to the filesystem root, project rules simply do not load.
- Global rules render before project rules (broad to specific).

The `.agents/rules` convention has no documented frontmatter field semantics, so no field is interpreted: every file injects verbatim after stripping a leading YAML frontmatter block (machine metadata), keeping only its prose body.

## Rendered shape

```md
<system-reminder>
The following agent rules were loaded once at session start and are frozen for this session. Use them as guidance when applicable. They do not override system, developer, or direct user instructions.

<agent_rules>
<rule origin="global" path="~/.agents/rules/style.md">

<rule content, its own markdown headings untouched>
</rule>

<rule origin="project" path=".agents/rules/api.md">

<rule content>
</rule>
</agent_rules>
</system-reminder>
```

Per-file framing is an XML-style element (matching the skill-catalog convention) rather than markdown headings: rule files carry their own `#`/`##` headings, and a heading-based frame would invert the hierarchy against them. Global rules precede project rules (broad to specific). Content that literally contains `</rule>` or a frame-closing tag is escaped.

The section is inserted right after the deployment persona section (`deployment:persona`), so it precedes tool guidance.

## Relationship to dsh-agent-instructions

DSH's own `@deepseek-ai/dsh-agent-instructions` loads `AGENTS.md`/`CLAUDE.md` instruction files (user-global `$DSH_HOME/AGENTS.md` plus the project directory chain, with nested discovery and change tracking). This plugin covers the complementary `rules` directories that mechanism does not interpret, and deliberately loads nothing else: no `CLAUDE.md`, no `.claude/` paths, no `@path` imports.

## Install

Published on npm as [`dsh-agents-rules`](https://www.npmjs.com/package/dsh-agents-rules):

```sh
dsh plugin --profile web add dsh-agents-rules
```

Then skip to step 3 (Restart dsh) below.

From a checkout of this project (replace `<path-to-checkout>` below with its absolute path):

### 1. Build the package

The profile imports the built `lib/` output, so build before installing and after every source change:

```sh
pnpm install
pnpm run build    # tsc -> lib/
pnpm test         # optional sanity check
```

### 2. Install into your profile

Standard path — let `dsh plugin` run pnpm for you (the package declares itself as a bundle via `dsh.bundle.patch`, so it joins the profile's layer stack automatically):

```sh
dsh plugin --profile web add <path-to-checkout>
```

**Fallback when pnpm refuses with a store-version conflict** (seen when the profile's `node_modules` was created by an older pnpm major — error text mentions two store paths, e.g. `...store\\v10` vs `...store\\v11`). Do the two things `dsh plugin` would have done, by hand:

1. Register the bundle in `~/.dsh/profiles/web/package.json`:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-agents-rules"
         ]
       }
     },
     "dependencies": {
       "dsh-agents-rules": "link:<path-to-checkout>"
     }
   }
   ```

   (keep any other bundles/dependencies the profile already lists; append, do not replace)

2. Make the bare package name resolvable — link it into both resolution roots (Windows junctions shown; a symlink works elsewhere):

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-agents-rules" -Target '<path-to-checkout>'
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-agents-rules" -Target '<path-to-checkout>'
   ```

### 3. Restart dsh

Bundles load at process start; a running server does not pick up a newly added bundle row. Restart the dsh process (e.g. the one serving the Web GUI) after installing or after changing this package's `cordis.patch.yml`.

### 4. Verify

- Offline composition check — the row must appear in the dump:

  ```sh
  dsh --profile web --dump-config | Select-String agents-rules
  ```

- Live check — start a **new** conversation (existing sessions are frozen by design), pick a workspace that has `.agents/rules`, send one message: the rules context message (`<agent_rules>` block) appears directly in the conversation, after your message, framed like the skill catalog. Searching the conversation for a rule filename (e.g. `english-code-comments`) must hit.

### Uninstall

Remove the row from `dsh.profile.bundles` (and the dependency), delete the two junction links, restart dsh.

## Configuration

The bundle patch inserts one row (`id: agents-rules`); override it from your profile's `cordis.patch.yml` (a patch replaces the whole row config, so restate every field you keep):

```yaml
- id: agents-rules
  config:
    agentsHome: ~/.agents
    projectRootMarkers: ['.git']
    maxBytes: 65536
    maxFileBytes: 262144
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `context` | `context` = durable user-role message (conversation-visible); `system-prompt` = one prompt section after the persona. |
| `agentsHome` | `~/.agents` | Home holding the global rules; they load from `<agentsHome>/rules`. A leading `~` expands against the OS home. |
| `projectRootMarkers` | `['.git']` | Bare file names that identify the project root when walking up from the session cwd. |
| `maxBytes` | required | Total byte budget for the complete rendered section. Non-positive disables injection. |
| `maxFileBytes` | `262144` | Per-file byte cap; an oversized rule file is skipped and listed in the notes. |

Budget behavior: whole files drop from the broad (global) end first, each drop recorded in the closing notes; if a single file still overflows, it truncates with a visible marker. Misconfiguration (non-finite `maxBytes`, relative `agentsHome`, marker names containing separators) fails loud at plugin load.

## Degradation

- No `ctx.fs` provider mounted: the adapter warns once per session and contributes nothing (providerless products stay bootable).
- A rules directory that is temporarily unavailable (provider error): one warning; the session's snapshot omits it, and a new session retries.
- Reads are bounded (`maxFileBytes`) and cancellation-safe; a read that exceeds the cap is skipped and listed in the notes.

## Model Experience

### What the model sees

One system-prompt section after the persona, containing the frozen rule snapshot of the session's first assembly.

#### Token effect

The section costs tokens once per session and stays fixed for that session's lifetime; `maxBytes` bounds it.

#### KV Cache effect

Prefix-stable within a session: the section text never changes between assemblies of one session, so it does not invalidate the request prefix. New sessions assemble their own snapshot.

## Known Limitations

- The snapshot is frozen per session by design; there is no refresh command. Start a new session (or fork) to pick up edited rules.
- No per-file conditional loading: the convention defines no applicability semantics, so every discovered file injects unconditionally.
- The frozen snapshot is process-local memory keyed by the live agent; it is not persisted in the session log (the system prompt is reconstructed at assembly, per DSH's architecture).

## Development

```sh
pnpm install
pnpm run build   # tsc -> lib/
pnpm test        # vitest
# self-contained smoke tests (fixtures under the OS temp dir; after build)
node tests/user-paths.smoke.mjs
node tests/scope.smoke.mjs
node tests/real-fs.smoke.mjs
node tests/symlink.smoke.mjs
```
