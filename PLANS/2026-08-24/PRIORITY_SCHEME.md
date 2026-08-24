# Priority scheme

Four levels, P0-P3. One shared definition across Trello, task records, the reminder
loop, Discord capture, and voice. Missing priority always means P2, so old cards need no
backfill and tooling never breaks on absence.

## Priority is one of three axes

- **Priority (P0-P3)**: how soon this matters. Drives ordering, reminders, and the right
  to interrupt a human.
- **Tier (T1-T4)**: whose attention the work gets right now (focus / review /
  background). Already shipped in task records.
- **Risk (low / medium / high / critical)**: how dangerous the change is. Drives review
  depth (phase 3). Already shipped as `changeRisk`.

They stay independent. A P1 task can run at T3 (urgent but delegated to background
agents); a P3 task can be high risk (touches player data, so it still gets the hardened
review when someone eventually does it). Conflating these is how "urgent" ends up
meaning "reviewed less".

## The levels

| | Name | Meaning | Entry criteria | Response expectation |
|---|---|---|---|---|
| P0 | Emergency | Players or revenue are hurt right now, or a launch today is blocked | Owner + due date within 48h required at creation | Drop current work, same day |
| P1 | Committed | Promised to someone, or has a real deadline | Due date required when the card enters Ready | This week, worked before any P2 |
| P2 | Normal | Standard work, done in order | None; this is the default | In priority order, no deadline implied |
| P3 | Someday | Nice to have, ideas, polish | None | May never happen; that is fine |

Studio examples: a live game's shop erroring is P0. Setting up the 30-day reward before
its date is P1 (the exact incident this system exists to prevent: it was a commitment
with a deadline nobody wrote down). A balance tweak from playtest notes is P2. "Maybe
add pets to the arcade lobby" is P3.

## What each level commits you to

Priority is a contract, not a mood. Each level means concrete clocks, and the tooling
fills the clocks in when the human does not:

| | Acknowledge | Start | Default due date if none given |
|---|---|---|---|
| P0 | within 1 hour, any channel | immediately, drop current work | 24 hours from creation |
| P1 | same day | within 2 working days | end of the current week |
| P2 | none required | pulled in order from Ready | none |
| P3 | none | never scheduled | none |

So "P0" literally means "done or downgraded within 24 hours": if a P0 is still open at
24h the advisor escalates it to Studio HQ's Decisions Required, because either it is
being worked (fine, say so on the card) or it was never really a P0 (demote it).
"Acknowledge" means any visible claim: assigning yourself, a card comment, or the pin
reaction on the Discord message. The capture bot and the triage agent apply the default
due dates automatically, which is what makes the contract enforceable instead of
aspirational: a P1 created from Discord with no date still gets an end-of-week clock,
and the reminder loop takes it from there.

## Where it lives

- **Trello**: one custom field named `Priority`, dropdown P0/P1/P2/P3, created
  identically on every board (same manual step as the existing Agent field; the provider
  matches custom fields by name, so no per-board ids). Field badge shown on the card
  front. No priority labels: labels stay reserved for machine-managed state (Due Soon,
  Overdue, Blocked); lists stay workflow stage; custom fields carry intrinsic properties
  (Agent, Priority).
- **Task records**: new `priority` field (`0`-`3`), synced from the card's custom field
  by the provider on read and written back through the existing custom-field write
  endpoint. Queue and Tasks panels sort by it before `updatedAt`.
- **Absent = P2** everywhere, by rule.

## How to say it

Spoken and written aliases, for the voice registry, the Discord bot's extractor, and
humans typing:

- **P0**: "p zero", "emergency", "drop everything", "prod down", "showstopper"
- **P1**: "p one", "urgent", "asap", "high priority", "this week", "today"
- **P2**: "p two", "normal", "standard"
- **P3**: "p three", "low", "someday", "backlog polish", "nice to have", "whenever"

Phrases the ladder should understand: "make that P1", "bump the reward card", "park it"
(P3), "what are my P1s", "anything urgent on Zoo?", "what P0s are open".

Capture defaults (Discord bot and voice task creation):

- No priority words -> P2.
- Urgency words ("urgent", "asap", "today", "this week") -> P1, and the bot asks for or
  infers a due date, since P1 requires one at Ready.
- P0 is never auto-assigned from a casual phrase. Only an explicit "P0" / "emergency" /
  "prod down" maps there, and it goes through the confirm-first flow like destructive
  commands do. This is the alert-fatigue firewall: a P0 that pages people must be a
  deliberate act.
- Down-words ("someday", "nice to have", "low priority", "whenever") -> P3.

## System hookups and defaults

**Reminder loop cadence** (extends `TRELLO_STUDIO_OS.md`):

| | Due Soon alert | Due-day alert | Overdue | No due date set |
|---|---|---|---|---|
| P0 | at creation and 24h before | yes, plus 4h re-alert until claimed | every alert channel, daily | not allowed; advisor flags immediately |
| P1 | 24h before | yes | Discord + UI, daily | advisor flags when card enters Ready |
| P2 | 24h before, if dated | yes, if dated | UI, daily; Discord after 3 days | silent |
| P3 | none | none | none | silent |

**Advisor rules** (new, alongside the existing ones):

- P0 open longer than 24h: escalate to Decisions Required on Studio HQ.
- More than 2 open P0s or more than 5 open P1s across boards: "everything urgent means
  nothing is" advice, prompting a triage pass.
- P1 in Ready without a due date; P0 without an owner.

**WIP interaction**: the two-parent-cards-per-human limit counts P0-P2; P3 never counts.
P0 is allowed to break the limit (that is what an emergency is), and the advisor says so
when it happens.

**Supervisor urgency**: priority joins tier as a weight on findings from card-linked
sessions: P0 2.0, P1 1.3, P2 1.0, P3 0.7. A P0-linked finding clears the interruption
budget's `alwaysInterruptAbove` threshold by construction; P3 findings effectively only
ever reach the digest.

**Batch launch ordering**: candidate cards launch P0 first, then P1, then due date,
then list position. Suggested `startTier` default when a card launch does not specify
one: P0/P1 -> T2, P2 -> T3, P3 -> T4 (board mapping override wins). P0 deliberately does
not default to T1: T1 is where the human already is, and a P0 launch usually is that
work.

**auto-trello score formula**: `PriorityBoost` derives from the field instead of its own
number: P0 pins to top of list regardless of score, P1 +2, P2 0, P3 -2. One priority
source, two consumers.

## The triage agent

Humans should not hand-rank every card, and capture-time defaults only see one message.
The router agent (phase 4 item 4) gets a second duty: triage. It reads guidance, not
vibes, and its guidance inputs are all things that already exist or land in phase 1:

- This document (the level semantics and entry criteria).
- Studio HQ's Current Priorities list and the milestone cards with dates.
- The dependency graph (`taskDependencyService`) for blocked-by relationships.
- The pairing service's conflict scoring (`processPairingService`: file overlap, same
  project, parallel PRs) for "these two cards will collide" detection.
- The board snapshot for duplicate detection (fuzzy title/description match across
  boards, the deterministic check the trello-task skill currently only pretends to do).

What it does, per new card at capture time and in a daily Inbox sweep:

1. Proposes priority and a due date, with a one-line reason citing the guidance
   ("mentions the August 28 milestone card, so P1 due 27th").
2. Flags overlaps and conflicts, including potential ones caught before work starts,
   not just collisions already in flight:
   - **Duplicates**: probable duplicate of card X; link them, propose closing one.
   - **Code conflicts**: two cards (Ready or In Progress) that will touch the same
     files or system; propose sequencing or a dependency link. In-flight overlap comes
     from the pairing service's changed-file scoring; predicted overlap for not-yet-
     started cards comes from the agent reading the descriptions against the repo map.
   - **Sequencing conflicts**: B only makes sense after A; propose the dependency.
   - **Schedule conflicts**: the same owner holding more P0/P1 clocks than the WIP
     limit allows in the same window, or several P1s converging on one milestone date;
     propose which one moves.
   - **Product conflicts**: two cards pulling the same feature in opposite directions
     (one nerfs the economy, one buffs it); flag for a human decision, never auto-pick.
3. Proposes board routing when a card landed in the wrong project's Inbox.

Apply rules follow the same firewall as capture: P2/P3 assignments and duplicate links
auto-apply with the reasoning left as a card comment; anything P0/P1, any due-date
change on someone else's card, and any close-as-duplicate needs a human yes (the
approval queue reuses the Atlas proposal pattern: agents propose, one click applies, an
approved proposal is indistinguishable from hand-curation). Every triage decision is a
card comment, so the audit trail lives where the work lives.

The weekly failure mode this prevents is silent misfiling: a committed task sitting at
P2 with no date because nobody typed "urgent" in Discord. The triage agent catches it
because the milestone card says otherwise.

## Backburner and 1% better work

Low priority has two failure modes: cards that quietly rot for months, and small
"makes it 1% better" improvements that never win a priority contest against anything,
ever, despite being exactly what compounds into a polished game. Both get explicit
handling so low priority never means invisible.

**Staleness ages.** Every card gets a decision at a known age; surfacing is not
escalation, the priority never changes on its own:

- P2 untouched for 30 days: the triage agent proposes one of demote to P3, give it a
  date, or fold it into a bigger card. The proposal waits in the Friday close-out.
- P3 untouched for 90 days: quarterly archive candidate (already in the rules below).
- The daily sweep also produces a backburner report on Studio HQ: oldest cards, count by
  board, and what it proposed for each, so "been sitting there for ages" is a report you
  read, not a discovery you make.

**The 1% lane.** Small, self-contained improvements (a sound effect, a tooltip, a
magic-number cleanup, a load-time shave) get a `1%` label plus the existing
Benefit/Effort fields; the auto-trello score already ranks exactly this shape of card
(high benefit over effort floats up). Then the lane feeds itself:

- When T3/T4 capacity is free (`launchAllowedByTier` already computes this) and the
  usage budget is healthy (the router knows), the router batch-launches the top-scored
  `1%` cards at T4, capped at a couple per day.
- They go through the normal pipeline: low risk, so the cheap review path; evidence and
  PR-merge automation move the card like any other work.
- Result: the backburner becomes the default diet of otherwise-idle background agents
  instead of a graveyard, and polish accumulates without ever outranking a P1.

A monthly Backburner Review recurring card (reminder loop) has a human skim the report
and the lane's output, so the automation stays supervised.

## Anti-inflation rules

- Overdue never auto-escalates priority. An overdue P2 stays P2 and stays visible until
  a human completes, reschedules, or cancels it. Auto-bumping is how every card becomes
  P1 by Christmas.
- P0 and P1 are claims about commitments, not feelings of importance. If it has no
  deadline and nobody is waiting, it is P2 no matter how good the idea is.
- The Friday close-out reviews every P0/P1: still true, done, or demoted. P3 cards
  untouched for 90 days surface in a quarterly archive sweep, not in anyone's queue.
