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
- Where #1043 and #1029 both carry a subsystem (supervisor, discordWatch, appServer),
  take the fresher #1029 copy (70 unique commits, three documented review passes,
  including the auto-approve RCE fix) and diff against #1043's copy for any extra fixes.

## The train

### 1. #1041, voice architecture doc
Merge now. Docs only, MERGEABLE, and it is the spec the rest of the train implements.

### 2. #1083, execution result contract
Land first of the reliability fixes: it repairs a live silent-failure bug (handler-level
failures surfaced as success) and is the least behavioral change. The three fix PRs
overlap in `voiceCommandService.js`/`index.js`/`voice-control.js` and each documents its
intended merged state; do the manual reconciliation in this order.

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
Two competing implementations exist:

- #1022 `reviewWorkflowService` + `config/review-workflows.json`: risk->workflow
  defaults, stage prompts that include earlier verdicts, GitHub-review polling with race
  guards, evidence integration. Heavier, more complete.
- #1043 `reviewChainService` + `config/review-chains.json`: simpler, spawns read-only
  child processes (`codex exec -s read-only`, `claude -p` with an allowlisted read-only
  tool set), strict VERDICT line parsing, speaks progress.

Take #1022 as the base (workflows-as-data, risk defaults, evidence, stage-aware
prompts) and port two things from #1043: the read-only spawn boundary (a malicious PR
diff must not be able to steer a reviewer into writes) and the voice/track narration
hooks. Also port #1022's `evidenceService` + `docs/agents/EVIDENCE_PROTOCOL.md` +
`shellSafety.js` in the same PR, and the task-record extensions it depends on.
Drop whichever config file loses; one schema only.

### 7. Supervisor + interruption budget (from #1029)
`supervisorService.js` + `server/supervisor/*` + `config/supervisor-rules.json`. Ship
with the branch's own security fix for the auto-approve allowlist (path-based denies for
`.git/hooks`, `package.json`, shell rc files). Verify tier weights read from the live
task-record tiers.

### 8. Discord ambient watch (from #1029)
`server/discordWatchService.js` + `server/routes/discordWatchRoutes.js` +
`config/discord-watch.json` + its unit tests. Additive
alongside main's `discordIntegrationService` (different feature, zero file overlap).
Gate behind config, off by default in the public repo.

### 9. Codex app-server bridge (from #1029)
`server/appServerService.js` + `server/agents/*`. Opt-in via `CODEX_APP_SERVER=true`,
degrades to PTY heuristics when off. Carries two live-tested protocol fixes (restart
leaves bridge uninitialized; request id 0 vs "0" map lookup); keep them.

### 10. Multi-commander + custom agents + visibility presets (from #1022)
`commanderManager.js`, `config/custom-agents.example.json`, `visibilityPresetService.js`,
`contextSwitchTelemetryService.js`, `serverLaunchCommandResolver.js`, and the
`prReviewAutomationService`/`commanderService` bug fixes the branch documents. Split into
two PRs if review size demands (presets/telemetry vs commander/agents).

### 11. Close out the old branches
After extraction, close #1043, #1029, and #1022 with a comment pointing at the landed
train. Do not delete the branches (history).

## Verification per landing

Each PR in the train: `node --check` on touched server files, the branch's own unit
tests migrated and green, `npm run check:command-surface` where the command registry is
touched, and a live smoke of the specific lane (voice utterance end to end, one review
chain on a throwaway PR, supervisor tick against a stalled dummy session).
