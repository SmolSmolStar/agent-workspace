# Trello as the studio operating system

Trello stays the permanent home of work. Discord is conversation, GitHub is code, the
orchestrator is execution. This doc turns the external advice ("one workspace, the HQ board,
standard lists, due-date discipline") into concrete steps against what actually exists.

## Workspace and boards (manual admin, one sitting)

1. One company workspace; move all eleven boards into it (Epic Survivors, HyFire, Zoo
   Hytopia, Roblox Zoo, Kpop Clicker, Ball Dropper, Toy Store, Squishy Battle Pets,
   Orchestrator, Arcade World, Calm Crypto).
2. New board `00 - HQ` with lists: Studio Inbox, Current Priorities, Decisions
   Required, Cross-Project Blockers, Upcoming Milestones, Recurring Operations, Decision
   Log. One permanent status card per active project (objective, stage, owner, next
   milestone, health, links to board/repo/build/analytics).
3. Standardize lists on every active project board:
   Inbox / Backlog / Ready / In Progress / Review-Testing / Blocked / Done.
   Categories are labels and custom fields, not extra lists.
4. Card discipline for committed work: one accountable owner, the Priority custom
   field (P0-P3, default P2; levels, clocks, and aliases defined in
   `PRIORITY_SCHEME.md`), type label, a concrete completion condition in the
   description, links to the Discord context, and a due date with reminder whenever the
   work is a commitment. Create the Priority dropdown on every board alongside the
   existing Agent field; the provider matches custom fields by name.
   Parent-card rule for agent-heavy work: one human-owned parent card, agent jobs as
   linked cards or checklist items under it. WIP limit: two parent cards In Progress per
   human.

A store-choice note: GitHub Projects v2 was evaluated as the alternative
(`GITHUB_PROJECTS_SWAP_ANALYSIS.md`). Trello stays for now; the reminder loop and triage
agent below are built against the provider interface, not Trello REST, so that decision
stays reversible.

## Not everything becomes a PR

PR linkage is one completion path, not the model. A card is the unit of work; a PR is
just how code-type work happens to finish. Plenty of studio work never touches GitHub:
Roblox dashboard and store-page changes, ad campaigns, signing up for services,
renewals, research, playtest sessions. The type label decides which automation applies:

| Type | Deliverable | How it completes |
|---|---|---|
| Feature / Bug / Technical | a PR | merge automation moves the card; review chains apply |
| Content / platform config (Roblox settings, store pages, ads) | changed state on an external service | owner marks it done with proof (screenshot or comment on the card); computer-use verification can supply the evidence |
| Research | findings | agent-doable end to end: launch against the card, deliverable posted back as a card comment or attachment |
| Operations (sign-ups, renewals, emails) | done in the world | human-only; the reminder loop is the whole system here; "mark X done" by voice or bot closes it |

Everything else in this plan is type-blind: due dates, reminders, priority contracts,
the triage agent, the HQ board, and the calendar all run on cards whether or not a repo is
involved. Only batch launch and PR-merge automation are code-specific. Two follow-ons
this implies: the "done with proof" habit reuses the evidence protocol (a screenshot on
the card is evidence, same as on a PR), and a later batch-launch tweak can run Research
cards in a scratch worktree with the result returned to the card instead of a branch.

## Premium or not

The advice assumes Premium for workspace table/calendar/planner and card mirroring. Not
required: the orchestrator's combined view is already a cross-board kanban (it just has
never been configured), and the reminder loop below plus a small calendar pane covers
dates. Decide Premium later on its own merits; nothing in this plan depends on it.

## Orchestrator configuration (config, not code)

1. `boardMappings` for all boards: `trello:<boardId>` -> localPath, repositoryType,
   defaultStartTier. This is what makes batch launch possible on the nine unmapped
   boards. (Dependency tracking already works on any board; the Roblox Zoo entry in
   `TRELLO_BOARDS.md` records a shortLink, not a board id, so resolve the real id
   first.)
2. `boardConventions` per board: doneListId, forTestListId, comment template. PR-merge
   automation works unconfigured via list-name matching; conventions make the targets
   explicit.
3. Enable `automations.trello.onPrMerged`. Merged PR -> card commented and moved. The
   agent prompt already embeds `trello:<shortLink>` so the linkage is automatic when
   launches go through batch-launch.
4. Populate `combined.selections` with each board's Ready + In Progress + Blocked lists:
   that is the studio-wide table view, for free.
5. Replace the CLAUDE.md manual multi-curl batch-launch choreography with
   `POST /api/tasks/batch-launch` (`dryRun: true` first). The endpoint already does
   worktree pick, agent detection from the card's Agent custom field by name, prompt
   assembly with title + full description + Trello tag, task-record linkage, launch, and
   card move.

## The reminder loop (the one new service)

`server/trelloReminderService.js`, singleton, config-gated, polling every 5 minutes
across mapped boards (board snapshot call already exists and is cached):

- **Due soon**: within 24h -> add Due Soon label, top of list, notify owner
  (orchestrator notification + Discord #work-alerts webhook). Alert cadence scales with
  the card's priority level per the table in `PRIORITY_SCHEME.md` (P0 re-alerts until
  claimed, P3 never alerts).
- **Overdue**: past due, not complete -> Overdue label, alert to Discord, repeats daily
  until completed, rescheduled, or cancelled. Overdue never goes silent.
- **Blocked follow-up**: cards in Blocked carry a next-review date; ping when it passes.
- **No-date guard**: committed cards (Ready / In Progress) without a due date get an
  advisor nudge, so the card-discipline rule has tooling behind it instead of memory.
- **Recurring operations**: a small template table (in settings) creates cards on
  schedule into Recurring Operations / project boards: Monday priority selection, weekly
  playtest, weekly analytics review, build verification, Friday close-out, monthly
  backburner review (see `PRIORITY_SCHEME.md`), release checklist, post-release
  analytics. Completing a recurring card just ends that occurrence; the schedule creates
  the next.
- **Escalation channels**: orchestrator UI toast + activity feed always; Discord webhook
  per severity; optional phone push later (the ADHD system already has a hardened
  notification path if a personal channel is wanted).
- **State**: last-seen snapshot per board in the data dir so restarts do not re-alert;
  every alert appended to a JSONL audit like the Discord bridge does.

This service also finally supplies the four-queues `backlog` count (`supported: false`
today): Backlog + Ready list sizes across mapped boards.

Why orchestrator-side instead of Trello Butler: we own the code, it works on the free
tier, alerts route through the same channels as everything else, and the logic can see
task records (tier, risk, evidence) that Butler cannot.

## Capture rules (Discord)

Adopted as posted policy, enforced by tooling in phase 2:

- Any actionable request becomes a card; the bot replies with the card link and adds the
  pin reaction. Mention without a card is not an assignment.
- Screenshots attach to the card (bot upgrade), so "the image was in Discord somewhere"
  stops being a failure mode.
- The bot extracts due phrases and priority when present (or asks in-thread), so
  committed cards arrive dated instead of relying on someone adding the date later.
- Bugs from testers become cards before they are treated as accepted work.
- #work-alerts (read-only, automated) and #blockers channels; the reminder loop and
  supervisor post there.

## Hygiene backlog

- Consolidate the three Trello shell scripts into one that sources
  `~/.trello-credentials`, rotating the credentials as part of the consolidation.
- Sync the `trello-task` skill board table to the full board list; keep
  `TRELLO_BOARDS.md` as the single source; retire `TRELLO_WORKFLOW.md`.
- Real duplicate detection: a helper that pulls the board snapshot and does deterministic
  fuzzy matching before card creation, replacing eyeball-the-list.
- auto-trello: fix the failing token (401 on score/sort since months, backup fine), add
  failure alerting to #work-alerts, or retire the Actions jobs and fold scoring into the
  reminder service. Merge or close its stale dependency-pin PR.
