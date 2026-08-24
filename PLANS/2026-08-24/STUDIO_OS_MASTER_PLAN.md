# Studio OS master plan

One system for a small game studio: tasks that cannot be forgotten, Discord that cannot
swallow work, agents that know what to do, and visibility across every project, teammate,
and machine.

This folder is the output of a research sweep (13 parallel scouts plus two PR-specific
passes) across this repo (including the four big unmerged PRs), the Trello and Discord
tooling, the standards-distribution repos, the Repo Atlas, the usage-limits layer, two
private productivity apps, and T3 Code as external prior art. Companion docs:

- `CURRENT_STATE_INVENTORY.md`, what exists today, what is on, off, stale, or broken
- `LANDING_THE_BRANCHES.md`, the PR train for #1041/#1083/#1081/#1085/#1043/#1022/#1029
- `TRELLO_STUDIO_OS.md`, Trello as the task store: workspace shape, config, reminder loop
- `PRIORITY_SCHEME.md`, P0-P3: definitions, time contracts, spoken aliases, the triage agent
- `TEAM_VISIBILITY_AND_CROSS_MACHINE.md`, limits sharing and task hand-off between people and machines
- `CONTEXT_DISTRIBUTION.md`, role/platform/task-scoped CLAUDE.md and skills distribution
- `GITHUB_PROJECTS_SWAP_ANALYSIS.md`, the Trello vs GitHub Projects v2 evaluation and pilot plan
- `FINAL_IMPLEMENTATION_PLAN.md`, the authoritative build document after the three-model
  review round; where this file and that one disagree, that one wins

## The core finding

Almost nothing on the wishlist needs to be invented. The research found four states of
"we already have this":

1. **Built and merged but switched off or unconfigured.** PR-merge-to-Trello automation,
   PR review automation, the whole process/tier dashboard UI, the cross-board combined
   view, Trello board mappings (2 of 12 documented boards configured), the batch-launch API that
   replaces the manual curl choreography still documented in CLAUDE.md.
2. **Built but sitting on unmerged branches.** The entire JARVIS voice tier ladder
   (#1043), evidence-driven review chains (#1022), the fleet supervisor with tier-weighted
   interruption budgets, ambient Discord work tracking, and the Codex app-server bridge
   (#1029), plus three voice reliability fixes (#1081/#1083/#1085).
3. **Built but never exercised.** Repo Atlas audiences/compiler/proposals (zero curated
   entries, zero audiences), the Discord signed queue (the queue directory has never
   existed on disk), task-record-to-Trello linkage (zero cards ever linked).
4. **Genuinely missing.** A due-date/reminder loop, recurring cards, Discord image
   capture, teammate identity and limits visibility, cross-machine task routing, any
   role/platform/task axis in instruction distribution, criticality-based review depth.

The plan is therefore mostly: land, turn on, configure, connect. New code is concentrated
in a reminder loop, a Discord capture upgrade, a review-depth classifier, a limits-aware
launch router, a limits/task fleet layer, and a context compiler.

## Decision: keep Trello as the task store

Confirmed, not just assumed. The orchestrator already has a full Trello provider
(`server/taskProviders/trelloProvider.js`, 668 lines), a ticket registry, a dependency
graph across `pr:`/`trello:`/`worktree:`/`session:` ids, batch launch from cards, and
PR-merge card automation. Twelve documented boards exist and the team knows them. Building a custom
store would discard all of that for months of migration. What Trello lacks (reminders,
recurring ops, rollups, capture discipline) is exactly what the orchestrator and the bot
can add around it. Trello Premium is optional: its workspace table/calendar can be
replaced by the orchestrator's combined view plus a calendar surface (see
`TRELLO_STUDIO_OS.md`).

## Target architecture

```
INPUT                      BRAIN                        STORE                 EXECUTION
voice (hotkey/phone/     T1 exact phrase              Trello (tasks,        Commander(s)
 button/browser)    -->  T2 tiny local model     -->   due dates,      -->  worktree agents
Discord messages         T2.5 deterministic data       boards, Trello HQ)          review chains
typed commands           T3 local brain               task records          bare-agent fleets
                         T4 Commander + router        dependency graph      teammate machines

FEEDBACK: realtime manager narration, supervisor with interruption budget,
          Discord #work-alerts / #blockers, reminder loop, usage-limit pills
CONTEXT:  compiled CLAUDE.md bundles per role x platform x framework
```

Boundaries, stated once:

- **Trello is the only durable home for work.** Discord creates work, never stores it.
  GitHub stores code. The orchestrator stores execution state (task records, tiers,
  evidence) keyed to Trello cards and PRs.
- **The ADHD system stays a separate private product.** It is a personal capture,
  reminder, and coach app (Rails), feature-complete but not yet deployed. The bridge
  between it and the studio is Trello plus a thin HTTP contract, not a code merge. Its
  three software capture surfaces (Windows pill, Android bubble, browser) already solved
  idempotent voice capture; the studio side reuses the pattern, not the codebase.
  Everything ADHD-related is optional for the public product.
- **The voice ladder lives in the orchestrator** (it is already built there on #1043) and
  is optional/off by default in the public repo, config-gated like Discord is today.
- **Launched agents run with real credentials.** A card-launched agent runs with
  permission bypass and can read local credential files and push code. That is why the
  security invariants in `FINAL_IMPLEMENTATION_PLAN.md` exist: external text never
  launches a write-capable agent without a human decision, and unattended lanes get
  scrubbed environments. The exposure is named here so nobody optimizes it away.

## Phases

Each phase is a set of PR-sized items, priority-ordered within the phase. The real
dependency graph is the DAG in `FINAL_IMPLEMENTATION_PLAN.md`; in short, the state and
normalization work in WP0 precedes the reminder loop and capture, the context compiler
runs fully parallel, and phase 5 gates on identity and lease work, not on reminders.

### Phase 0: land what is already built

Split after review into 0a (the quick lands and one-line fixes, small) and 0b (the
extraction train, the largest engineering item in the plan, gating only phases 3-4).
The dependency ordering now lives as a DAG in `FINAL_IMPLEMENTATION_PLAN.md`.
See `LANDING_THE_BRANCHES.md` for the full train. Summary:

1. Merge #1041 (voice architecture doc). Mergeable today, docs only.
2. Land the voice reliability train in its own documented order: #1083 (execution result
   contract, a live silent-failure bug on main), then #1081 (confirm-first destructive
   commands, a live safety gap; needs a rebase first, it reports CONFLICTING), then
   #1085 (MP4/Safari audio).
3. Split and rebase #1043/#1029 into a five-PR train, dropping the stale Atlas subtree
   entirely: voice core, review chains, supervisor, Discord watch, app-server bridge.
4. Reconcile the two competing review-chain implementations (#1022's
   `reviewWorkflowService` vs #1043's `reviewChainService`) into one. Decision after the
   review round: #1043's smaller engine (which already owns the read-only spawn
   boundary) is the base; #1022's workflows-as-data config, risk defaults, and evidence
   protocol port into it; verdicts become structured JSON validated and posted by the
   trusted parent, bound to the PR head SHA. Full contract in `LANDING_THE_BRANCHES.md`
   step 6 and `FINAL_IMPLEMENTATION_PLAN.md` WP3.
5. One-line fixes and doc repairs: delete the hardcoded `display:none` on the header
   Review Inbox button (`client/index.html:87`); document the nine `process*` services
   and the whole `taskProviders`/`batchLaunchService`/`prMergeAutomationService`
   subsystem in `CODEBASE_DOCUMENTATION.md` (currently invisible to anyone following the
   repo's own reading instructions); fix the stale `~/.orchestrator` paths starting with
   this repo's own `CLAUDE.md`, then `PLANS/2026-01-25/*` (the data dir is
   `~/.agent-workspace` now).

### Phase 1: Trello becomes the studio OS (mostly config, little code)

Full detail in `TRELLO_STUDIO_OS.md`.

1. Create the single company workspace and the Trello HQ board; standardize lists on
   active boards (Inbox/Backlog/Ready/In Progress/Review-Testing/Blocked/Done); create
   the shared Priority custom field (P0-P3, defined with time contracts and defaults in
   `PRIORITY_SCHEME.md`) on every board. Manual, one sitting.
2. Fill `boardMappings` and `boardConventions` for all twelve boards in orchestrator
   settings. Mappings make batch launch possible on the ten unmapped boards;
   conventions give PR-merge automation explicit done/test lists instead of list-name
   guessing. (Dependency tracking already works on any board.)
3. Turn on `automations.trello.onPrMerged`. The merged-PR-moves-the-card flow is written,
   tested, and off.
4. Rewrite the CLAUDE.md "Trello batch launch" section to call
   `POST /api/tasks/batch-launch` (dry-run first) instead of the fragile sleep-timed
   multi-curl sequence it currently teaches.
5. New code, the one big missing piece: a **reminder loop** service. Polls due dates
   across mapped boards, fires escalating notifications (orchestrator UI, Discord
   webhook to #work-alerts, optional phone push) under the single interruption policy,
   applies Due Soon/Overdue labels, nudges committed cards that carry no due date,
   supports recurring operational cards (Monday priorities, weekly playtest, analytics
   review, release checklists), runs on the leader instance only, and posts a daily
   digest even when empty so its own silence is an alarm.
   The 30-day-reward failure then dies in two places: capture (phase 2 extracts due
   dates so committed cards arrive dated) and follow-through (a dated card cannot go
   silent in every channel at once).
6. A calendar surface: either Trello's per-board calendar view, or a small orchestrator
   pane rendering due dates across mapped boards (the reminder loop already fetches
   them). Decide when building; the data source is the same.
7. Hygiene: consolidate the three Trello shell scripts into one that sources
   `~/.trello-credentials`, rotating the credentials as part of the consolidation; sync
   the `trello-task` skill's 4-board table with the 12-board reality; retire the stale
   duplicate docs.

### Phase 2: Discord that cannot lose work

1. Rework and land the ambient watcher (from #1029): cursor-based reading of project
   channels, but every detected commitment ends as a dated Trello card proposal through
   the triage queue, never a local-only work item (the branch's own `discord:` records
   would dead-end outside the reminder loop). Claims must reference a specific card,
   reply, or nonce. See WP2 in `FINAL_IMPLEMENTATION_PLAN.md` for the full rework list.
2. Upgrade `discord-task-bot`: capture message attachments and attach them to the created
   Trello card (today the screenshot is silently dropped and the card says "Image");
   parse due phrases and priority from the message, or ask in-thread, so committed cards
   arrive dated; reply to the source message with the card URL and a pin reaction; read
   board routing from orchestrator config instead of the hardcoded four-project map.
3. Close the bypass: the bot's fallback path that pastes raw prompts into any live
   session via `send-to-session` skips every hardening layer. Remove it; if the hardened
   endpoint fails, the bot should report, not improvise.
4. Turn on the hardening that exists: dedicated API token, producer-side queue signing in
   the bot (verification already ships server-side), the queue cadence schedule.
5. Publish the card-creation contract for teammate-run bots (Hermes and future ones): a
   documented endpoint plus the signed-queue producer spec, so teammates' agents stop
   parsing raw channel logs to guess at tasks.
6. Outbound alerts: reminder loop and supervisor findings post to #work-alerts; blocked
   cards post to #blockers. Discord operating rules from the advice doc get adopted
   verbatim as channel policy (actionable request -> card, reply with card link, pin
   reaction means captured).

### Phase 3: review chains by criticality

The chain engine, evidence protocol, and read-only reviewer spawning all land in phase 0
(see `LANDING_THE_BRANCHES.md` step 6). This phase builds what does not exist anywhere
yet:

1. A risk classifier on PR tracking: diff size, paths touched (player data, economy,
   deploy, auth are high-risk by pattern), declared tier, and explicit override, mapped
   to a workflow id. The shipped config maps low -> standard; add a `none` workflow and
   a skip predicate (docs-only, trivial diffs) so minor changes get no review at all,
   which the shipped config cannot express.
2. Schema: extend `taskRecordService` review fields from scalars to a list of
   `{lens, outcome, body, agent, spawnedAt}` passes, and re-key `activeReviewers` by
   `prId+stage` (today a second reviewer per PR is blocked by design).
3. Lens prompts: adapt the already-written role prompts (critic, security, integration,
   migration, plan-adherence) from the continuous-claude-lite-v3 agent library as stage
   prompt bodies instead of the single generic review prompt.

### Phase 4: voice and the assistant ladder

Phase 0 lands the ladder itself (T1 exact match, T2 grammar-constrained tiny model with
registry-grounded guards, T2.5 deterministic data fetchers, T3 local brain, T4
Commander). This phase connects inputs, intents, and the router:

1. Input surfaces: browser push-to-talk exists on main. The Windows hotkey pill and
   Android bubble exist in the ADHD system; add one intent to its capture router
   ("studio task" routes to Trello/orchestrator instead of the personal store) so both
   reach the studio with no new capture UI. Preconditions: the ADHD system deploys, and
   the intent is built there (optional, private). The hardware button is design-only
   today; it inherits the same route once built.
2. New intents for the ladder: create task with due date, assign to person, "what is due
   today/this week", "what is blocked", "launch card X on my other machine" (phase 5).
   The people/project alias registry (#1043's `voice-registry.json`) is where teammates
   and project nicknames live, including the squishy-pets naming chain (Roblox name vs
   repo folder vs engine demo path) so nobody has to re-explain it per session.
3. Feedback: realtime manager narrates transitions only, supervisor findings gated by the
   tier-weighted interruption budget (T3/T4 background work structurally cannot yank
   attention, the exact property the user asked for).
4. The limits-aware launch router: a tier-4 policy step that picks agent CLI, model, and
   reasoning effort from the normalized usage-limit shape before any spawn, hooked into
   the existing admission-controller seam (`sessionManager.setAgentAdmissionController`,
   which the Codex weekly guard already uses). Policy thresholds live in config as data.
   Local-only here; phase 5 adds the other machine's budgets as inputs. The same agent
   carries triage duty: proposing priority, due dates, and overlap/conflict flags for
   new cards from written guidance (see the triage agent section of
   `PRIORITY_SCHEME.md`), auto-applying only the low-stakes calls.
5. Recalibrate T2 on real transcripts (the GEPA harness and transcript log ship with
   #1043) once real usage accumulates.

### Phase 5: teammate visibility and cross-machine routing

Full design in `TEAM_VISIBILITY_AND_CROSS_MACHINE.md`. Summary:

1. Identity: a real migration, not just wiring the null `requestingUser` (review found
   the code overwrites the workspace `access` field with GitHub repo visibility, and one
   teammate entry already exists in live config). See WP5.
2. Limits sharing: publish per machine/member using the versioned window-array schema in
   `FINAL_IMPLEMENTATION_PLAN.md` (Claude, Codex, and Grok do not share one shape today;
   Codex and Grok report window arrays). Transport v1 is the Atlas git-sync pattern (one
   JSON file per machine, conflict-free, zero new networking); v2 is direct pairing.
3. Task hand-off v1 is Trello, not networking: assigning a card (member field, plus the
   Machine field created in phase 1) with a prompt artifact means the receiving
   orchestrator offers a local launch with the pre-cached prompt, guarded by a
   card-scoped launch lease so two machines cannot double-launch.
   `promptArtifactService` already exists on main (233 lines, routes, encryption),
   unexercised; batch launch must learn to consume artifacts, since today it reads only
   card title and description.
4. Cross-machine v2 borrows T3 Code's model (Environment = machine, pairing token, QR,
   headless serve): pair your two computers, show both machines' limits, and route a
   launch to the machine with the healthiest budget, feeding the phase 4 router.

### Phase 6: context distribution (roles x platform x task)

Full design in `CONTEXT_DISTRIBUTION.md`. Summary:

1. Fix the bootstrap gaps that exist today: two of the six registered standards repos
   sit outside the `.ai-install.yml` convention (their symlinks would not survive a
   fresh machine), one config key is silently unparsed, one repo is a redundant
   self-clone, and a third-party skill pack lives outside the registry entirely.
2. Extend the same `.ai-install.yml`/bootstrap mechanism with role and platform axes,
   compiling CLAUDE.md and AGENTS.md from fragments instead of maintaining one repo per
   audience. The Repo Atlas audience compiler (visibility, groups, per-audience
   redaction, machine-local facts never leave) is the in-repo precedent for the
   visibility model; the instruction compiler itself is a new small script.
3. Fold role-based access grants into repo creation, so "create the repo, then remember
   who to invite" stops being a manual step.

### Phase 7: efficiency and cadence

1. Expose bare-agent fleets through the orchestrator (spawn/status/collect as API +
   panel, reusing the existing build-script spawn pattern), so mechanical fan-out is a
   button instead of a personal shell script, and fleets appear alongside sessions. The
   `resume`-switches-billing-mode fix lands in the private standards repo where the
   script lives.
2. Weekly cadence as recurring cards plus advisor rules: Monday priorities, Friday
   close-out, "no task stays overdue without a decision". The advisor service already
   emits exactly this kind of nudge; it is just hidden by default.
3. Re-surface the process UI deliberately, using the Simple/Power visibility presets
   landed in phase 0, instead of the current everything-hidden defaults.

## What this plan deliberately does not do

- No platform migration now. ClickUp/Linear/Notion are ruled out; GitHub Projects v2 is
  the one credible alternative and gets a real evaluation plus a post-phase-1 pilot in
  `GITHUB_PROJECTS_SWAP_ANALYSIS.md`. Until that pilot decides otherwise, Trello plus
  the orchestrator covers it, and the reminder loop and triage agent are built against
  the provider interface so the swap stays a provider-sized PR.
- No merge queue in the CI sense. Nothing found justifies stacked-merge infrastructure at
  current team size; the review chains plus PR-merge automation cover the actual pain.
- No cloud relay for v1 cross-machine. Trello-as-queue and git-sync limits sharing get
  90% of the value with 5% of the code; direct pairing comes after.
- No new capture apps. Three software capture surfaces already exist in the ADHD system;
  the studio reuses them through one routing intent.

## Sequencing

Dependency-ordered slices, not dates. Phase 0 is small next to the value it releases;
most of the code already exists.

1. Phase 0 items 1, 2, and 5: the mergeable doc, the contract fix, the one-line repairs.
2. Phase 1 items 1-4: workspace admin plus config flips.
3. Phase 2 item 2: image and due-date capture, the most visible daily win.
4. Phase 1 item 5: the reminder loop.
5. The rest of the phase 0 train, then phases 2-4 in order; phases 5 and 6 start any
   time after phase 1 items 2 and 5 exist.
