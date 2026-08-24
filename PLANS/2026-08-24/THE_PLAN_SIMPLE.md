# The plan, simply

Trello holds the work. An agent brain decides what happens at every step: nothing in
this system is a fixed pipe. Agent Workspace is where you see and steer all of it.

## What happens when you say something

```mermaid
flowchart TD
    V["Voice: hotkey, phone, button"] --> BR
    K["Typing: Commander, UI"] --> BR
    DC["Discord channels"] --> DB
    DB["Discord bots: ours, plus teammate bots<br/>like Hermes through a documented contract"] --> BR

    BR["THE BRAIN (orchestrator agent)<br/>cheap lanes first: exact phrase, tiny local model, local chat model,<br/>Commander Claude only when it actually needs to think"]

    BR --> A1["Just answer you"]
    BR --> A2["Ask back / confirm first"]
    BR --> A3["Create one or MANY Trello cards"]
    BR --> A4["Update, complete, or reprioritize cards"]
    BR --> A5["Launch one or more agents"]
    BR --> A6["Alert someone / post to Discord"]
    BR --> A7["Hand work to another machine or teammate"]
```

Every arrow out of the brain is a choice it makes per request. A Trello card is one
possible outcome, not the outcome.

## What happens to a card

- The triage agent proposes priority, due date, duplicates, and clashes with other work.
  Small calls apply themselves with the reasoning left as a comment; anything P0/P1 or
  destructive waits for a human yes.
- The reminder loop is budgeted, not a spam cannon. Interruptions go through the same
  budget the supervisor uses: so many per hour, minimum gaps, quiet hours, low-grade
  stuff batched into a digest. Only a P0 is allowed to keep breaking through. Everything
  else escalates by channel (UI first, Discord later) and then lands in the Friday
  close-out, where a human decides: finish it, reschedule it, or kill it. Overdue never
  disappears, and it also never turns into infinite pinging.

## How code work finishes

Launch from the card (one call, card text becomes the prompt, agent works in a
worktree) -> PR opens. Then review is sized by risk, and it is not always automatic:

| Change | Review |
|---|---|
| Trivial (docs, tiny fix) | none |
| Normal | one agent reviewer |
| Dangerous (player data, economy, launch week) | several agents with different lenses, PLUS a human |

Merging is a person's call unless that repo and change type is explicitly allowed to
auto-merge. Some teammates can merge on some projects and never on others; that policy
lives in config, not in vibes. Whoever merges, however they merge, the card then moves
itself. That last step is the only automatic part.

## Where results go

Wherever fits: a PR, a card comment, a doc, a Discord reply. Research might end as
findings on the card, or as a PR, or both. The only rule: the card links to wherever
the result lives, so the trail is never lost.

## What you see in Agent Workspace

This all surfaces in the app you already run:

| Surface | Shows |
|---|---|
| Terminal grid | every agent working, grouped by worktree; Focus / Review / Background mode filters what is on screen |
| Queue / Review Inbox | everything waiting on a review or a decision, sorted by priority and tier |
| Tasks panel | your Trello boards inside the app, including the all-boards combined view |
| Jarvis panel (Alt+J) | what the supervisor found, the batched digest, Discord work it spotted, proposals waiting for your yes |
| Header | your remaining Claude/Codex/Grok budget; later your teammates' and your other machine's too |
| Voice | the realtime manager speaks only on real changes (agent finished, something broke), silent in background mode |

## Where data lives

| Data | Lives in |
|---|---|
| Tasks, priorities, due dates, screenshots | Trello: one workspace, the twelve boards, plus the Trello HQ board (the studio-level board: one status card per game, decisions needed, cross-game blockers) |
| Code and PRs | GitHub, as now |
| Which card = which agent session, reviews, proof | `~/.agent-workspace/task-records.json` on each machine (already exists) |
| Team data every machine needs (AI budget left, member list) | one small private git repo, synced automatically |
| Names and nicknames for voice ("the kpop game", people) | one config file per machine |
| Chat | Discord. Disposable. Anything that matters gets captured out of it within minutes |

## How it hooks into what you already have

| You have | What happens to it |
|---|---|
| Orchestrator / Agent Workspace | The center. Already contains the Trello client, card-to-agent launcher, PR automation, task records. Mostly switched on and configured; new code is the reminder loop, triage duty, and the brain's routing |
| Jarvis (branch #1043) | Gets merged. It IS the brain's voice lanes: exact-phrase, tiny model, local chat, Commander |
| Discord bot | Kept and upgraded: screenshots onto cards, priority and due date from your words, card-link replies. Teammate bots (Hermes) plug in through a published contract instead of scraping logs |
| ADHD system | Stays its own private app. Its phone/hotkey capture gets one route: "studio task" goes to the studio instead of your personal list |
| Your 2 computers | Each publishes remaining budget to the shared repo; the brain can route a launch to whichever machine has headroom |
| Teammates | You see their budget, you assign a card with a ready-made prompt attached, their orchestrator offers it for launch |
| CLAUDE.md repos | One script builds each person's CLAUDE.md from shared pieces (role + OS + projects) instead of hand-maintained copies |
| Trello vs GitHub Projects | Staying on Trello. Small trial later on the Orchestrator board; all new code talks to a neutral ticket layer built first, so swapping stays cheap |

## Build order

(The full dependency graph and schemas live in `FINAL_IMPLEMENTATION_PLAN.md`; this is
the short version, reviewed by three independent models.)

1. Safety first, small: land the three quick fix PRs and the docs PR; make the state
   stores atomic and single-writer; lock down the raw send-to-session endpoint; add the
   text sanitizer; build the neutral ticket layer every new piece talks to.
2. One Trello sitting: workspace (paid tier check first, twelve boards), the Trello HQ
   board, same lists everywhere, Priority and Machine fields. Turn on "merged PR moves
   the card".
3. The alerts engine (one interruption policy shared with the supervisor) then the
   reminder loop, leader-only, with its own dead-man alarm.
4. Upgrade the Discord bot (images, dates, card links); rework and land the ambient
   watcher so caught commitments become dated card proposals; publish the contract for
   teammate bots.
5. Land the big branches by subsystem: review chains sized by risk with human gates and
   tamper-proof verdicts, then the voice brain, supervisor, and app-server bridge.
6. Budget-aware routing, team budgets, the second computer, card hand-off with launch
   leases.
7. The CLAUDE.md builder (runs in parallel with everything after step 1).
