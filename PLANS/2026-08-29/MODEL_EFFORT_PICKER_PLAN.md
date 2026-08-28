# Model/Effort picker + Start Agent modal redesign

Branch: `feature/model-effort-picker`
Worktree: `work-model-effort-picker` (sibling of `master/`, never edit inside `master/` —
it's the live production checkout, nodemon watches it and a restart kills every session).

## Full request (verbatim scope, do not drop items)

### 1. Header model/effort chip -> dropdown
- The terminal-header chip that currently just shows text (e.g. "Sonnet High") becomes a
  dropdown trigger.
- Click OR hover opens it (auto-open on hover for desktop; mobile requires a tap, but tap
  must also work everywhere, not just mobile).
- Left column: models, dynamically populated from the current harness (Claude/Codex/Grok/
  etc.) of that specific session.
- Hovering/clicking a model reveals an effort flyout to the right (low..xhigh/max, or
  whatever that harness+model actually supports — NOT the same list for every model).
- Selecting a (model, effort) pair sets it **session only** — must NOT overwrite the user's
  persisted default. For Claude this means: snapshot `~/.claude/settings.json` `model`/
  `effortLevel` before sending `/model <name>` (which the CLI docs confirm always saves as
  default when typed with a name), then restore those two fields after the CLI has written
  its switch — the live process already has the new model in memory, only the on-disk
  default needs reverting. Verify by reading the file back. Needs the equivalent mechanism
  investigated/implemented for Codex and Grok (their own config/session-override paths).
- Bottom of the dropdown: a manual refresh button, for when the model/harness list looks
  wrong or stale.
- Backing data: per-harness catalog of available models + valid efforts per model, cached
  (instant open), refreshed on a ~12h background job plus the manual refresh button. Cache
  must not go stale "within reason."

### 2. "Start AI Agent" modal redesign (`client/agent-modal.js` + `#agent-startup-modal` in
   `client/index.html`)
- Replace with three rows of REAL BUTTONS acting as radio groups (no native `<select>`):
  1. Harness (provider)
  2. Model
  3. Effort
- Each row cascades into the next — changing harness repopulates model options, changing
  model repopulates effort options.
- Fix the current jank: switching from Claude to Codex today swaps in a differently-sized
  `flag-configuration` block (Codex's `model`/`reasoning`/`sandbox` flag categories) and the
  whole modal grows/reshifts vertically. Pull `model` and `reasoning` out of that generic
  flags system into the new dedicated model/effort rows; keep sandbox/permission flags
  as their own (smaller, more consistent) section.
- Use each provider's actual logo (small, compressed SVG/PNG) + name — remove emojis
  entirely from this modal. Logos already exist under `site/assets/`: `claude-logo.svg`,
  `codex-logo.png` (no svg yet — check/source one), `grok-logo.svg`, `gemini-icon.svg`,
  `opencode-logo.svg`. Copy/optimize what's needed into `client/assets/`.

### 3. Icon swaps (mid-turn addendum, easy to lose — do NOT drop)
- The refresh icon top-right (terminal header) should become the small agent-workspace logo
  (the one already used top-left of the agent window), so it visually reads as "this starts
  the agent."
- The "review" icon is literally a folder emoji today — find/use a better icon for it.

### 4. Commander parity (mid-turn addendum, most recent — do NOT drop)
- Commander instances currently default to Claude. Add the ability to start a Commander as
  Codex, Grok, or any other supported provider/model/effort — same picker as #1/#2.
- User also floated changing Commander's default model to "Luna medium fast" — **no known
  model named Luna in this stack** (Claude family is Opus/Sonnet/Haiku/Fable only; nothing
  else in agentModelConfigService/model-config docs matches "Luna"). Likely a voice-dictation
  mishearing. Flagged, NOT implemented — needs the user to confirm the actual model name
  before touching Commander's default.
- Commander's own header must get the same session-only model/effort dropdown as regular
  worktree terminals (#1), not a separate mechanism.

## Key existing files (already read this session)
- `server/agentModelConfigService.js` — resolves CURRENT model+effort per session
  (Claude settings cascade, Codex `~/.codex/config.toml`, Grok `~/.grok/config.toml`).
  Only resolves what's active, not the catalog of what's *available* — need to extend.
- `GET /api/sessions/model-config` (server/index.js) — badge data source today.
- `client/app.js` — model badge chip rendering (~line 141-148, 745-790, 6529-6538),
  `agentModalManager` wiring (~line 1203), `showClaudeStartupModal`/`startAgentWithConfig`
  (~17050-17260).
- `client/agent-modal.js` — `AgentModalManager` class, full modal render logic
  (agent-options / mode-buttons / flag-configuration), fallback hardcoded agent configs
  when `/api/agents` fails to load — but `/api/agents` DOES exist server-side
  (`server/index.js:4456`), need to read its real shape.
- `client/index.html:162-203` — `#agent-startup-modal` markup.
- `client/styles.css:1750-1830ish` — `.terminal-model-badge` styling.
- `server/commanderService.js` — Commander PTY service, multi-instance (`main`, `cmd-2..6`).

## Open questions / risks
- Codex/Grok session-only-switch mechanism unconfirmed — needs its own investigation
  (their CLIs may not have a `/model` equivalent with the same default-save behavior;
  don't assume Claude's settings.json trick ports over).
- Blindly automating an interactive TUI picker (arrow-keys) is fragile — prefer the
  snapshot/restore-settings approach over keystroke navigation wherever the harness exposes
  a settings file we can snapshot.
- 12h refresh job needs a scheduler — check if one already exists in this codebase
  (teamActivityService's `startBackgroundRefresh()` pattern is the precedent to copy).

## Status
Just started. Plan written before first line of code, per repo AI-memory convention.
