# Landing the branches

Seven open PRs hold most of the studio OS. Two pairs overlap, all four big ones conflict
with main, and one subsystem (Repo Atlas) evolved independently on main and must be
dropped from the branches that carry it. This is the reconciliation order.

## Ground rules

- Never merge the big branches as-is. Both #1043 and #1029 report CONFLICTING and carry
  a stale pre-#1057 Atlas fork; main's Atlas is strictly larger (nine files the branches
  never had). Every `server/atlas/*`, `server/repoAtlasService.js`, `scripts/atlas.js`
  change on those branches is noise to discard.
- Extract by subsystem, not by branch. The five shared wiring files
  (`server/index.js`, `client/app.js`, `client/index.html`, `client/styles.css`,
  `CODEBASE_DOCUMENTATION.md`) are the conflict surface; small PRs touch them once each.
- File-to-branch source-of-truth table (a prose rule proved wrong: the branches share
  eleven MORE files than first mapped, all voice core, and #1043's `voiceBrainService`
  is 854 lines vs #1029's 303, so "take the fresher branch" applied mechanically would
  delete the tier ladder): **#1043 wins** the voice set (`server/voice/*`,
  `speechService`, speech/voice routes, `config/voice-providers.json`, client
  voice/jarvis files); **#1029 wins** supervisor, discordWatch, and appServer (its
  copies carry the later review passes including the auto-approve deny-path fix).
  `server/voiceCommandService.js` appears on four open branches (#1081, #1083, #1029,
  #1043) and gets its own written merged shape before any of them land.

## The train

### 1. #1041, voice architecture doc
Merge now. Docs only, MERGEABLE, and it is the spec the rest of the train implements.

### 2. #1083, execution result contract
Land first of the reliability fixes: it repairs a live silent-failure bug (handler-level
failures surfaced as success) and is the least behavioral change. Measured overlap facts
(the earlier prose was wrong): #1083 and #1081 share `voiceCommandService.js`,
`commandRegistry.js`, `commander-panel.js`, `playwright.config.js`, the voice unit test,
and docs; #1081 and #1085 share `voice-control.js`; all three share only
`server/index.js` plus `CODEBASE_DOCUMENTATION.md`. #1081 is additionally a ~35-file
e2e-harness refactor, so its rebase explicitly converts #1083's new spec file to the
extracted harness.

### 3. #1081, confirm-first destructive commands
Second: a real safety gap on main today (a misheard "stop all claudes" executes
immediately for an authorized caller). This is the one fix PR that reports CONFLICTING;
rebase it onto main before sequencing.

### 4. #1085, MP4/Safari recordings
Third: smallest and most isolated.

### 5. Voice core (cherry-picked from #1043)
New branch from main carrying only: `server/voice/*` (tier2Intent, voiceRegistry,
voiceQuery, voiceBrain, realtimeManager, voiceProvider), `server/speechService.js`,
`server/routes/{speechRoutes,voiceProviderRoutes}.js`, the `config/voice-*` files,
`docs/JARVIS_VOICE_SYSTEM.md`, client Jarvis panel/chat-log/lab, and the registry wiring
into `commandRegistry`/`index.js`. Re-run the branch's own unit tests plus the live-lane
checklist from its PR body. Everything is additive files except the wiring points, so the
rebase is mostly clean.

Public-repo note: ship `config/voice-registry.json` as placeholders only (the branch
already splits real identities into a user overlay file), and keep the whole ladder
behind a config flag, off by default. While landing, move the overlay path off the
branch's hardcoded `~/.orchestrator/voice-registry.json` onto `getAgentWorkspaceDir()`,
since phase 0 is simultaneously retiring stale `~/.orchestrator` references.

### 6. Review chains, reconciled (#1022 + #1043)
Two competing implementations exist. Decision REVERSED after the three-model review:

- Keep **#1043's `reviewChainService`** (182 lines) as the engine, because it already
  owns the read-only spawn boundary, and porting a security property between
  implementations is the riskiest possible move.
- Port INTO it #1022's workflows-as-data config (`review-workflows.json` schema wins,
  `review-chains.json` dropped), risk defaults, and stage-aware prompts.
- Drop #1022's GitHub-review-polling verdict detection entirely: its reviewers submit
  `gh pr comment`/`gh pr review` (writes), which contradicts read-only reviewing, and
  polling is what created the misattribution races its own code guards against.
- Replace verdict handling in both implementations: #1043's regex matches the FIRST
  "VERDICT:" anywhere in output, so a PR merely containing that string self-approves.
  New contract: reviewers return strict JSON to the parent; the trusted parent
  validates exit status, schema, stage, a per-run nonce, and the PR head SHA, then
  posts the GitHub review itself; any head change invalidates all passes; the critical
  gate is a required GitHub check.
- Reviewer summaries forwarded to any permissioned session are fenced as untrusted, or
  routed to the review inbox instead of auto-forwarded.
- `server/agentSpawnHelper.js` (#1022, previously in no train step) lands here with a
  two-mode contract written down: reviewer = detached read-only child process; fixer =
  permissioned session; its `FALLBACK_SPAWN_FLAGS` (skipPermissions/yolo) never applies
  to reviewers. #1022's evidence-aware `prReviewAutomationService` also lands here.
- `evidenceService` + `docs/agents/EVIDENCE_PROTOCOL.md` + task-record extensions land
  as the follow-up PR. `shellSafety.js` moves to step 10 with its actual consumers
  (`agentManager`, `serverLaunchCommandResolver`). #1022's plugin subsystem
  (`pluginLoaderService`, client plugin files, `plugins/youtube-transcript`) is
  explicitly dropped from the train; revisit separately if wanted.

### 7. Supervisor + interruption budget (from #1029)
`supervisorService.js` + `server/supervisor/*` + `config/supervisor-rules.json`. Ship
with the branch's own security fix for the auto-approve allowlist (path-based denies for
`.git/hooks`, `package.json`, shell rc files). Verify tier weights read from the live
task-record tiers.

### 8. Discord ambient watch (from #1029, REWORKED, not landed as-is)
`server/discordWatchService.js` + `server/routes/discordWatchRoutes.js` +
`config/discord-watch.json` + its unit tests, with the WP2 rework applied before
landing: detected commitments become dated Trello card proposals through the triage
queue instead of local `discord:` work items (which the task-record allowlist silently
rejects today and the reminder loop would never see); claims reference a specific
card/reply/nonce instead of "latest open item in the channel"; archive instead of
truncating at 500; separate suggested-priority from suggested-tier. Additive
alongside main's `discordIntegrationService` (different feature, zero file overlap).
Gate behind config, off by default in the public repo.

### 9. Codex app-server bridge (from #1029)
`server/appServerService.js` + `server/agents/*`. Opt-in via `CODEX_APP_SERVER=true`,
degrades to PTY heuristics when off. Carries two live-tested protocol fixes (restart
leaves bridge uninitialized; request id 0 vs "0" map lookup); keep them.

### 10. Multi-commander + custom agents + visibility presets (from #1022)
`commanderManager.js`, `config/custom-agents.example.json`, `visibilityPresetService.js`,
`contextSwitchTelemetryService.js`, `serverLaunchCommandResolver.js`,
`server/utils/shellSafety.js` (moved here from step 6: its only consumers,
`agentManager` and `serverLaunchCommandResolver`, land in this step), and the
`commanderService` bug fixes the branch documents. Split into two PRs if review size
demands (presets/telemetry vs commander/agents).

### 11. Close out the old branches
After extraction, close #1043, #1029, and #1022 with a comment pointing at the landed
train. Do not delete the branches (history).

## Verification per landing

Each PR in the train: `node --check` on touched server files, the branch's own unit
tests migrated and green, `npm run check:command-surface` where the command registry is
touched, and a live smoke of the specific lane (voice utterance end to end, one review
chain on a throwaway PR, supervisor tick against a stalled dummy session).
