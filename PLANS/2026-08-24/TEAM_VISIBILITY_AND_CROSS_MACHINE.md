# Team visibility and cross-machine routing

Goals: see every teammate's plan limits before assigning work, assign a task plus a
ready-to-run prompt to a person or a machine, and let the router pick agent/model/effort
from real budget data. Today none of this crosses a machine boundary: `/api/usage/limits`
reports only the local box, and every session endpoint addresses local PTYs only.

## What already exists to build on

- `usageLimitsService` normalizes Claude (5h, 7d, per-model weekly buckets via the OAuth
  usage endpoint), Codex (app-server JSON-RPC), and Grok into one shape:
  `{available, updatedAt, stale, fiveHour, sevenDay, extraBuckets}`. That shape is the
  wire format; do not invent another.
- `codexUsageGuardService` already blocks local launches when a weekly window is drained.
  The same admission-controller hook generalizes to "route elsewhere when drained".
- Half-built teammate wiring: `access: private|team|public` on workspaces,
  `listWorkspaces(requestingUser)` filtering, `config.user.teammates`. All dead code
  because nothing supplies an identity. Finish it rather than redesign it.
- Prompt artifacts in the task-record design (`PLANS/2026-01-25/PROMPT_ARTIFACTS_PR.md`).
  Pre-cached card prompts have been used before and worked; the friction was driving
  them by hand, which batch-launch removes.
- The Atlas sync layer is a proven conflict-free multi-machine state channel: one JSON
  file per writer in a private git repo, pull-rebase-push, machine-local stuff never
  synced.
- Auth for direct connections exists (`AUTH_TOKEN` + `networkSecurityPolicy` bind
  guards); the mobile launch script already uses it.

## v1: no new networking

**Limits sharing via git.** Each machine runs a small publisher (interval or on-change):
write `limits/<member>-<machine>.json` (the normalized shape plus member, machine,
hostname, timestamp) into a private `studio-state` git repo, Atlas-style. Every
orchestrator pulls the repo on the same cadence and renders teammate pills next to the
local ones (stale marked by age). Latency of minutes is fine for "does this teammate
have Fable budget left this week".

**Task hand-off via Trello.** Assigning work to a person or their machine is a card
operation, not a network call:

1. Assign the card to the member (or set a Machine custom field for your own second box).
2. Attach the prompt: the batch-launch prompt builder already assembles title +
   description + context; store the curated version as the task record's prompt artifact
   and paste it into a card attachment/comment for portability.
3. The receiving side's orchestrator polls its assigned cards (reminder-loop
   infrastructure) and offers one-click batch-launch, or auto-launches at the card's
   `startTier` if the member has that automation on.

This gives "assign them a task in a prompt" with zero protocol work, full offline
tolerance, and an audit trail on the card.

**Router inputs.** The tier-4 router (Commander) reads the local limits plus the synced
snapshots and picks: which agent CLI (Claude/Codex/Grok), which model and effort, and
whether to keep the task local, hand it to the other machine's card queue, or defer.
Policy lives in config as data (thresholds per bucket), same shape the pace heuristic in
the usage widget already uses. The single-machine version of this router is phase 4
item 4; this section only adds the other machines' budgets as inputs.

## v2: direct pairing (borrowed from T3 Code)

T3 Code's model, verified from its repo/docs: Environment = one machine running a
server; clients pair via short-lived token/QR; remote access is a ladder (LAN or tailnet
bind, headless serve, SSH-managed launch with a tunneled loopback port); a hosted relay
(Cloudflare Worker, DPoP-bound tokens) is optional on top. Threads are event-sourced so
every client sees the same live state.

Adopt the shape incrementally:

1. **Pairing**: `POST /api/fleet/pair` mints a short-lived token + QR; the peer stores
   `{name, url, token}`. Reuse `AUTH_TOKEN` semantics per pair; loopback/tailnet binds
   only, never public.
2. **Peer proxy, read-only first**: `GET /api/fleet/peers`,
   `GET /api/fleet/:peer/limits`, `GET /api/fleet/:peer/sessions` proxy the peer's
   existing endpoints. The header widget grows a per-machine section; the git-sync
   publisher becomes the fallback when a peer is unreachable.
3. **Remote launch**: `POST /api/fleet/:peer/batch-launch` forwards a card launch to the
   peer. Idempotency keys and the audit-log pattern from the Discord bridge apply as-is.
4. **Later, if ever needed**: an event-sourced session mirror for live cross-machine
   terminal viewing. Expensive; the Trello card + limits view removes most of the need.

## Identity, minimal version

One `member` identity per orchestrator install (settings: name + optional GitHub login),
sent as a header on fleet calls and stamped into limits snapshots, task records, and
audit lines. Populate `config.user.teammates` from the studio-state repo membership.
That single field makes the dead `requestingUser`/`access` code meaningful without
building accounts or auth beyond the existing tokens.

## Open questions (decide during build, defaults chosen)

- Where the studio-state repo lives: default a private GitHub repo per the Atlas
  registry precedent.
- Whether teammates' orchestrators must run this repo's code: v1 yes (it is the product);
  a teammate without the orchestrator still gets Trello cards and Discord alerts, just no
  pills.
- Auto-launch on assignment: default off; explicit accept in the UI (or a per-member
  allow list for the user's own machines).
