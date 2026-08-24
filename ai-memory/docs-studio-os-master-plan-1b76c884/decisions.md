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
