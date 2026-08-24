# Current state inventory

Verified by direct reads during the 2026-08-24 research sweep (13 parallel scouts plus
two PR-specific passes, all read-only).
Every claim below was checked against code or live systems, not recalled from docs.
Baseline: origin/main at 1b76c884.

## Built, merged, working

| System | Where | Notes |
|---|---|---|
| Trello provider | `server/taskProviders/trelloProvider.js` | Boards/lists/cards/checklists/custom fields/comments, board snapshot with cache |
| Batch launch from cards | `server/batchLaunchService.js`, `POST /api/tasks/batch-launch` | Worktree pick, agent detection via any custom field named like "agent", prompt build, task-record link, dry run |
| Dependency graph | `server/taskDependencyService.js` | Cross-entity (`pr:`/`trello:`/`worktree:`/`session:`), cycle detection |
| Task records | `server/taskRecordService.js` | Tier, risk, review fields, Trello linkage fields; file under `~/.agent-workspace` (legacy `~/.orchestrator` wins only if the new dir is absent or empty, or the legacy dir holds more workspaces) |
| Process layer | `server/process{Task,Status,Advisor,Pairing,ProjectDashboard,ProjectHealth,Readiness,Telemetry,TelemetryBenchmark}Service.js` | Tiers T1-T4, WIP caps, advisor rules, pairing scores, telemetry; all wired, all unit-tested |
| PR plumbing | `server/pullRequestService.js` | gh-backed search/view/merge/review, 30s cache, parallel details fetch |
| Queue / Review Inbox / Review Console | `client/app.js` | Live; reachable from dashboard and palette |
| Voice (basic) | `server/voiceCommandService.js` + `server/commandRegistry.js` | Regex phrasebook + one-shot LLM fallback; 94 registry commands shared by voice/Commander/UI |
| Usage limits | `server/usageLimitsService.js` + header widget | Claude OAuth buckets incl. per-model weekly, Codex app-server JSON-RPC, Grok; Codex weekly guard can block launches |
| Repo Atlas | `server/repoAtlasService.js`, `server/atlas/*` (16 modules) | Discovery works (296 entries); audiences/compiler/encryption/proposals/sync implemented and tested |
| Session persistence | `server/utils/tmuxSessionBackend.js` | Terminals survive server restarts (tmux panes) |
| Discord queue bridge | `server/discordIntegrationService.js` | Signing, idempotency, audit log, rate limit; Services workspace runs the bot live today |

## Built and merged, but off / unconfigured / unused

| Item | State | One-line fix |
|---|---|---|
| PR-merge -> Trello card automation | `prMergeAutomationService` fully built, `enabled: false` | Config flip + per-board done/test list ids |
| PR review automation | `prReviewAutomationService` built, `enabled: false`, single-pass only | Enable after phase-3 multi-lens upgrade |
| Board mappings | 2 of 11 boards in `boardMappings` | Add the other 9 in Settings > Tasks |
| Combined cross-board view | Built; `combined.selections` empty, never populated | Configure selections |
| Task-record <-> Trello links | Live store has 1 record, 0 linked; the 28-record legacy store also has 0 linked | Use batch-launch (it links automatically) |
| Header Review Inbox button | Dead: hardcoded `style="display:none"` at `client/index.html:87` beats the `ui.visibility.header.queue: true` setting | Delete the inline style |
| Process/dashboard UI | Hidden by the 2026-02-21 cleanup; dashboard skips the fetches entirely | Visibility presets (phase 7) |
| Four-queues backlog count | `backlog: {supported: false}` hardcoded | Wire to Trello Ready/Backlog lists (phase 1) |
| Discord queue path | Signed/idempotent pipeline never exercised; `~/.claude/discord-queue/` has never existed on disk | Exercise in phase 2 |
| Discord auth/signing | Dedicated token auth and queue signing ship server-side; phase 2 enables them and adds the producer side | Phase 2 |
| Scheduler queue cadence | Template ships `enabled: false` | Phase 2 |
| Teammate visibility | `access: private/team/public` schema + `listWorkspaces(requestingUser)` filter exist; every call site passes null; `teammates` list empty; no identity layer | Phase 5 |
| Atlas audiences | Zero curated entries, zero audiences, no proposals ever made | Phase 6 seeds it |

## Built but unmerged (open PRs)

| PR | Contents | State |
|---|---|---|
| #1041 | `VOICE_TIERED_ARCHITECTURE.md`, the ladder spec | MERGEABLE now, docs only |
| #1043 | Voice tier ladder: T2 tiny-model intent (grammar-constrained + deterministic guards), people/project registry, T2.5 deterministic queries, confirm-first destructive, realtime manager, Kokoro TTS, `reviewChainService`, Jarvis panel. Also carries duplicate supervisor/discord-watch/app-server and a stale Atlas fork | 185 behind main, CONFLICTING |
| #1022 | Evidence service + protocol, `reviewWorkflowService` + `config/review-workflows.json` (standard/hardened/full-gate, risk defaults, p-chain rationale), visibility presets, multi-commander, custom-agent registry, shell-safety | 187 behind, CONFLICTING |
| #1029 | Fleet supervisor (tier-weighted urgency + interruption budget + digest queue), Codex app-server bridge (structured signals instead of PTY scraping), ambient Discord watch (cursor-based), realtime voice loop. Atlas files superseded by main | 185 behind, CONFLICTING |
| #1081 | Confirm-first for dangerous natural-language commands (live gap on main) | Open, CONFLICTING, needs rebase |
| #1083 | Execution result contract (`{success:true, ok:false}` contradiction; failures reported as success today) | Open |
| #1085 | MP4/Safari Whisper recordings (live breakage for Safari-class recorders) | Open |

Overlap warning: #1043 and #1029 both carry supervisor/discordWatch/appServer;
#1022 and #1043 carry two different review-chain implementations. One canonical landing
order is required. See `LANDING_THE_BRANCHES.md`.

## Adjacent repos

| Repo | State | Relevance |
|---|---|---|
| ADHD system (private Rails app) | Feature-complete dev system, not yet deployed; idempotent multi-surface voice capture (Windows pill, Android bubble, browser), command registry, coach with subscription-CLI sidecar + generic local-LLM fallback, versioned dedup-safe reminders; hardware button (M5Stack CoreS3) is design-only, no server endpoint yet | Capture surfaces + reminder patterns to reuse; bridge target |
| start-finishing-guide | Dormant since Jan; 155-command regex+Haiku voice classifier, wake-word controller, coach persona | Pattern donor only |
| auto-trello | Hourly score/sort workflows failing with 401 on every run for months (backup job succeeds, same creds; unexplained); nobody alerted | Fix or fold into orchestrator reminder loop; add failure alerting |
| discord-task-bot | Live via orchestrator Services workspace; mention-based task->card works; drops image attachments entirely; 4 hardcoded board routes; unhardened fallback path pastes raw prompts into any live session | Phase 2 rework target |
| continuous-claude-lite-v3 | 34 lens-scoped agent prompts + review/security/release chain skills; some steps depend on tools absent locally; never invoked | Prompt library for review lenses |
| bare-agent fleet | Works (safe-mode ~28.5k tokens/worker vs ~92k full); shell-only, no API surface, invisible to the orchestrator; `resume` silently switches to metered `--bare` | Phase 7 API wrapper |
| Standards repos (`~/.claude` et al.) | bootstrap/sync works for 4 of the 6 registered repos; `roblox-ai-standards` and `ai-standards` sit outside the `.ai-install.yml` convention (symlinks were made by hand, would not survive a fresh bootstrap); a seventh, unregistered third-party skill pack sits outside the system entirely; `orchestrator_source` key silently unparsed; `installed/ai-standards` is a stale self-clone; no role/audience/platform axis anywhere; Codex skill parity 5 of ~63 | Phase 6 |
| Hermes | Zero references in any local repo or data dir (confirmed by sweep). Teammate-run external bot; any integration would be new | Phase 2 notes |

## Genuinely missing (no implementation anywhere)

- Due-date polling, reminders, escalation, Due Soon/Overdue labels
- Recurring operational cards
- Discord image/attachment capture into cards
- Merge queue (only a one-line historical mention; deliberately out of scope)
- Criticality-based review depth on main (single generic pass only)
- Cross-machine anything: no peer discovery, no remote session addressing, no shared
  limits view (grep for remote/federation/peer over server+client: nothing)
- Role/platform/task-scoped instruction generation
- Reviewer multi-pass storage (task-record review fields are scalars; `activeReviewers`
  blocks a second reviewer per PR by design)

## Known live bugs worth naming

1. Voice/Commander command failures can report as success (`commandRegistry.execute`
   spreads handler results over `success: true`; client checks only `success`). Fix is
   #1083.
2. No confirm-first on destructive voice/free-text commands on main. Fix is #1081.
3. Safari-class audio uploads mislabeled/rejected. Fix is #1085.
4. Header Review Inbox button unreachable (inline `display:none`).
5. auto-trello score/sort automation silently failing for months (401), no alerting.
6. `docs/REVIEW_SYSTEM_DOCUMENTATION.md` describes a divergent, never-reintegrated
   lineage (feedback delivery routing, terminal review buttons, session auto-linking do
   not exist in live code). `PLANS/2026-02-21/REVIEW_QUEUE_WORKFLOW_REPORT.md` is the
   accurate reference.
7. `CODEBASE_DOCUMENTATION.md` omits the process layer and the entire Trello/ticketing
   subsystem.
8. Stale `~/.orchestrator` paths in this repo's own `CLAUDE.md` and across
   `PLANS/2026-01-25/*`; live default is `~/.agent-workspace` (the legacy dir wins only
   if the new one is absent or empty, or the legacy one holds more workspaces).
