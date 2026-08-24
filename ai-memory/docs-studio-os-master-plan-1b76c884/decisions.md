# Findings log

## PR 1022 + 1029 scout (done)
- PR 1022 (review hub): evidenceService (agent-evidence fenced JSON self-reports), reviewWorkflowService + config/review-workflows.json (standard/hardened/full-gate chains, riskDefaults low->standard high->hardened critical->full-gate), visibility presets, multi-commander manager, custom-agent registry, shellSafety. Fully unique vs main. 187 commits stale, CONFLICTING.
- PR 1029 (JARVIS autopilot): supervisorService (tier-weighted urgency 1.5/1.15/0.6/0.35 + InterruptionBudget + DigestQueue), Codex app-server JSON-RPC client (structured signals vs PTY scraping), discordWatchService (cursor-based ambient channel ingest -> task records, regex extractor tables in config/discord-watch.json), realtime voice loop, jarvis-panel (Alt+J). Atlas files on this branch are SUPERSEDED by main (main strictly larger + 9 extra files). 185 commits stale, CONFLICTING.
- Both touch server/index.js, client/app.js, client/index.html, client/styles.css, CODEBASE_DOCUMENTATION.md -> mutual conflicts.
- Keep-regardless concepts: evidence-driven review, chains-as-data + p_chain math, tier-weighted interruption budget, structured control-plane over PTY scraping, cursor-based external-feed ingest.

## PR 1043 + 1041 scout (done)
- PR 1043 implements the full voice tier ladder: T0 faster-whisper -> T1 exact-phrase (<50ms) -> T2 Bonsai-1.7B via llama.cpp :5742, grammar-constrained JSON + deterministic guard layer (registry-grounded entity resolution, homophone fixes, question-shape override) -> T2.5 voiceQueryService (deterministic gh/activity answers, no LLM) -> T3 local brain (Qwen3.5-9B) -> T4 Commander (sonnet-low default). confidence>=0.6 gate. Transcripts logged to ~/.orchestrator/voice-transcripts.jsonl for GEPA recalibration (prompt v14 hit 66/66 eval).
- voiceRegistryService: config/voice-registry.json + ~/.orchestrator overlay, longest-alias-first, people/projects/products. "Aliases are load-bearing."
- Confirm-first destructive regex + 30s pendingConfirmation window in voiceBrainService (854 lines).
- realtimeManagerService: transition-only narration, 30s floor, silent in background mode.
- reviewChainService (182 lines) + config/review-chains.json: default (codex->sonnet), high-risk (codex->opus), quick (sonnet). Read-only reviewer spawns (codex exec -s read-only / claude -p with allowlisted tools). VERDICT: approved | needs_fix parsing; needs_fix -> task record + forward to implementer session via Commander; NO auto re-run after fix (doc says re-run, code stops).
- PR 1043 also carries duplicate copies of supervisor/discord-watch/app-server (same as 1029) AND a stale atlas fork. 185 behind, CONFLICTING, atlas subtree must be dropped on rebase.
- PR 1041 = PLANS/2026-08-15/VOICE_TIERED_ARCHITECTURE.md spec, MERGEABLE as-is, safe to land any time.
- Doc verified: "Hermes agents: not a thing in this codebase (zero references)."
- NOTE: 1043 and 1029 overlap heavily (supervisor, discordWatch, appServer appear in BOTH). Plan must pick one canonical landing path.

## GitHub Projects v2 research (done)
- Fields: text/number/date/single-select/iteration; 50 fields/project, 50 options/select. Views: table/board/roadmap, NO calendar. Advanced AND/OR search GA 2026-07.
- Item limit 50k (GA 2025-04), archive 10k. Sub-issues (100/parent, 8 deep) + issue types (25/org) GA 2025-04; issue dependencies blocked-by/blocking GA 2025-08 (50 per relationship); gh CLI manages all three since 2026-06. Tasklist blocks dead (2025-04).
- Automation: built-in workflows (item added/reopened/closed, PR merged -> status, auto-add by query [Free: 1, Team: 5], auto-archive). NO native due-date reminders anywhere (community-requested, unshipped); milestones due_on silent; Slack scheduled reminders = PR reviews only. Teams use Actions cron + GraphQL.
- API: GraphQL only (no REST), projects_v2_item webhook includes prev+current values (2024-06); gh project subcommands cover fields/items; rate limits trivial for 5-min polling. Fine-grained PAT support UNVERIFIED.
- Images via bots: no official API; undocumented uploads.github.com/user-attachments endpoint works (unofficial, could die); safest = commit to assets repo. Discord CDN URLs expire, never hotlink.
- Access: Free org + outside collaborators = testers free; on Team plan every private-repo viewer needs a $4 seat. Mobile Projects = view/move/comment only, adding items broken (as of last reports).
- Insights charts: Free ~2 saved charts private, Team+ unlimited (best-effort).
