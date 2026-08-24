# Swapping Trello for GitHub Projects v2: analysis

Question: what would the studio OS look like on GitHub Projects v2 instead of Trello?
Inputs: a web research pass over the 2025-2026 Projects changelog and docs, and a
code-level coupling map of every Trello assumption in this repo.

## Verdict up front

The swap is genuinely attractive and gets more attractive the more agent-driven the
studio becomes: three of the plan's hacks (PR-link scraping, dependency checklists, the
hand-configured cross-board rollup) become native GitHub features. But it is not free:
the orchestrator's Tasks UI and half the ticket plumbing speak raw Trello JSON with no
abstraction layer, non-dev teammates lose Trello's mobile/simplicity, and the seat model
punishes upgrading the org plan. Recommendation: do not swap mid-build. Execute phase 1
on Trello, make two cheap provider-neutrality moves now, and pilot one board (the
Orchestrator's own, the most dev-only board) on a GitHub Project before deciding.
A permanent hybrid is rejected outright: two durable task stores means two sources of
truth, which is the disease this plan exists to cure.

## Concept mapping

| Trello | GitHub Projects v2 | Notes |
|---|---|---|
| Workspace | Organization | |
| Board | Project, or one org-wide Project with per-game views | 50k item limit (GA 2025-04) makes one-big-project viable |
| List | Option of the Status single-select field | "Move card" becomes "set field value" |
| Card | Project item wrapping an Issue (draft item for non-code) | |
| Custom field (Agent, Priority) | Project field, single-select | 50 fields/project, 50 options/field |
| Due date | Date field | Same reminder gap as Trello: nothing native fires on it |
| Labels (Due Soon/Overdue/Blocked) | Labels | Same machine-managed-state pattern works |
| Members | Assignees | |
| Checklists | Sub-issues (GA 2025-04, 100 per parent, 8 deep) | An upgrade, not a port |
| Dependencies checklist hack | Native blocked-by/blocking (GA 2025-08, 50 each way) | The hack gets deleted |
| Card attachments | No official API; commit images to an assets repo | See below |
| The HQ board | An HQ project, plus saved views on the main project | |
| Recurring cards | Actions cron creating issues | |
| auto-trello Benefit/Effort/Score | Number fields plus the reminder loop computing Score | |

## What gets better

- **PR-to-ticket linkage becomes native.** Today `prMergeAutomationService` regex-scrapes
  `trello.com/c/` links out of PR bodies because GitHub cannot know about Trello. With
  issues as tickets, "Closes #N" plus the built-in "PR merged -> Status: Done" workflow
  replaces most of that service. The dependency graph's `pr:owner/repo#N` id kind
  already exists; `issue:owner/repo#N` slots in beside it. Scope check: this only
  upgrades code-type work. Plenty of tickets never produce a PR (Roblox dashboard
  changes, research, sign-ups, ad campaigns); those become plain issues or draft items
  that close manually, by voice, or by the bot, exactly as their cards would on Trello.
  Parity for non-code work, improvement for code work.
- **Dependencies and subtasks stop being hacks.** Native blocked-by/blocking and
  sub-issues (both manageable from `gh` CLI since 2026-06) replace the
  Dependencies-checklist convention and its ten provider methods.
- **The centralized rollup is native.** One org-wide Project with board views sliced per
  repository is exactly the studio-wide table the plan builds from `combined.selections`
  config on Trello. Advanced AND/OR view filters went GA 2026-07. Roadmap view gives a
  timeline for milestones (still no true calendar layout).
- **Agent ergonomics.** Every machine in the fleet already authenticates `gh`. A
  `githubProjectsProvider` can shell out to `gh api graphql` exactly the way
  `pullRequestService` shells out to `gh` today: no second credential system, no
  Trello key/token distribution, and the webhook (`projects_v2_item`) even carries
  previous and current field values. Rate limits are a non-issue at our polling cadence.
- **Cost and fit.** Free tier covers private projects; the Trello subscription could
  eventually go. For this public repo's other users, a GitHub-native ticket provider is
  a far more natural default than Trello.

## What gets worse

- **Non-dev humans.** Trello's mobile app and drag-a-card simplicity beat GitHub for
  testers and artists. GitHub Mobile can view boards and move items but reportedly still
  cannot add items reliably. Mitigation: the plan's own direction reduces board-touching
  for non-devs anyway (capture and alerts happen in Discord and by voice), but this is a
  real regression today.
- **The seat trap.** On a Free org, outside collaborators on a repo cost nothing, which
  covers testers. The moment the org upgrades to Team ($4/user/month), every private
  viewer needs a seat; there is no free issues-only role. Whether org-level private
  projects are visible to outside collaborators at all needs a live check in the pilot.
- **Images by API.** Trello has an official attachment endpoint; GitHub has none. The
  workable options are committing screenshots to a small assets repo (safe, versioned)
  or an unofficial user-attachments upload endpoint that GitHub could remove without
  notice. Note this cuts both ways: Discord CDN URLs now expire, so the phase 2 bot must
  re-host images somewhere durable regardless of which store wins.
- **GraphQL-only.** No REST for Projects v2. `gh` CLI subcommands cover most needs, but
  the provider gets meaningfully more complex than Trello's flat REST calls, and
  fine-grained PAT support for the Projects API is still unverified.
- **Free-plan automation quotas.** One auto-add workflow per project on Free (five on
  Team). With eleven games feeding one project, auto-adding needs a trivial Actions
  workflow (issue opened -> `addProjectV2ItemById`) instead of the built-in rule.

## What does not change at all

Worth stating, because it is most of the plan:

- **The reminder loop is required either way.** GitHub has no native due-date reminders:
  date fields fire nothing, milestone due dates pass silently, and the only shipped
  scheduled-reminder feature covers PR reviews on Slack. The loop's design survives
  verbatim; only its data calls change (GraphQL poll or the webhook instead of REST).
- **The priority scheme is store-agnostic.** P0-P3 semantics, time contracts, aliases,
  the triage agent, staleness ages, and the 1% lane transfer unchanged; Priority becomes
  a single-select project field instead of a Trello custom field.
- **Review chains, evidence, batch launch, task records, tiers**: already keyed to PRs
  and local records, not to Trello.
- **Discord capture rules**: identical; the bot files an issue instead of a card.

## The engineering cost (from the coupling map)

The provider registry is pluggable (duck-typed, one registration line), but nothing
downstream is provider-neutral: every consumer reads Trello's raw JSON field names
(`idList`, `customFieldItems`, `shortLink`, `checklists`), the `/api/tasks/*` route
nouns are Trello's, `taskRecordService` has a literal `Set(['trello'])` allowlist,
`taskDependencyService` hardcodes `getProvider('trello')`, and the client Tasks modal
renders Trello shapes directly across roughly 5,000 lines.

Two implementation paths:

1. **Shape-faking provider** (~500-600 lines): a `githubProjectsProvider` that
   translates GraphQL results into Trello's exact JSON shape so every existing consumer
   keeps working. Feasible, ugly, fast; checklist methods map to sub-issues; "move to
   list" maps to a Status field write. Right choice for a pilot.
2. **Real normalization refactor**: introduce a neutral ticket model and rewrite the
   consumers against it, client UI foremost (est. 1500-2500 lines touched there alone).
   Right choice only after a decision to switch for good, and independently valuable if
   this repo ever wants a third provider (Linear, Jira) for its public audience.

Either path also needs the small unblocking fixes: widen the `ticketProvider`
allowlist, de-hardcode the two `getProvider('trello')` call sites, and make
`batchLaunchService` stop stamping `ticketProvider: 'trello'` unconditionally (a live
bug even for Trello-only use).

## Recommendation

1. **Stay on Trello for phase 1.** It is config-light, already paid, and the team knows
   it. Nothing in phases 0-2 gets cheaper by switching first.
2. **Buy provider neutrality cheaply now.** Build the reminder loop and triage agent
   against the provider interface and task records, never against Trello REST directly;
   land the three unblocking fixes above when those files are touched anyway. This keeps
   the swap a provider-sized PR instead of a platform migration.
3. **Pilot after phase 1**: move the Orchestrator board (dev-only, most code-centric) to
   a GitHub Project driven by a shape-faking provider v1. The pilot answers the open
   questions: outside-collaborator visibility on org projects, fine-grained PAT
   behavior, mobile reality in 2026, and whether the shape-faking layer holds up.
4. **Decision triggers for a full swap**: the pilot holds for a full cycle; the org
   either stays Free or accepts per-seat cost for every board viewer; non-dev teammates
   either accept the GitHub UX or genuinely interact only through Discord, voice, and
   reminders. If all three hold, migrate board by board and retire the Trello lane; if
   not, Trello stays and the pilot cost was one provider file.
