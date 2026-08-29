# Context distribution: role x platform x task

(Build requirements hardened after review: ownership manifest, refuse-unmanaged
overwrites, lock + validate + atomic replace, last-known-good, dry-run diff, golden
tests, and the migration table for existing CLAUDE.md files live in
`FINAL_IMPLEMENTATION_PLAN.md` WP6, which is authoritative over this doc.)

Problem: instructions and skills are distributed as whole repos symlinked at fixed
layers. It works for one person on one machine, but there is no way to vary content by
role (dev vs tester), platform (Windows/WSL/Linux), or task type, and every audience
variation today means another repo. Meanwhile agents burn context reading instructions
irrelevant to their job.

## What exists (verified)

- `shared-repos.yml` -> `bootstrap.sh` -> per-repo `.ai-install.yml`
  (`source:` + `targets:` per AI tool) -> symlinks. Works for 4 of the 6 registered
  repos; a seventh, unregistered third-party skill pack sits outside the system
  entirely.
- Layers: workspace root and framework level are symlinked shared repos; project and
  worktree levels are ordinary tracked files. No category layer (nothing between
  "all repos" and "hytopia games"). 682 CLAUDE.md files under the workspace tree.
- Defects: `roblox-ai-standards` and `ai-standards` have no `.ai-install.yml` (their
  symlinks were made by hand and would not survive a fresh bootstrap);
  the `orchestrator_source:` key in two repos is silently unparsed by bootstrap;
  `installed/ai-standards` is a stale second clone of `~/.claude` itself;
  Codex gets a hand-maintained subset (5 of ~63 skills, separate AGENTS.md).
- No role/audience/persona concept anywhere in the instruction files (grep confirmed).
- Precedent in this repo: the Repo Atlas compiler already does per-audience artifact
  generation with visibility levels, group membership, per-audience field redaction, and
  a hard "machine-local facts never leave" strip. That is the exact shape this problem
  needs, applied to instructions instead of repo metadata.

## Step 1: repair the existing mechanism (small PRs, immediate)

1. Add `.ai-install.yml` to `roblox-ai-standards`; either add one to `ai-standards` or
   remove it from the registry (it is `~/.claude` itself); delete the redundant clone.
2. Teach `bootstrap.sh` the `orchestrator_source:`/`orchestrator:` keys it currently
   ignores, and target `.agent-workspace-config.json` (the current name; the
   orchestrator treats `.orchestrator-config.json` as a legacy fallback), so those
   symlinks survive a fresh machine without entrenching the old filename.
3. Add the missing category layer where it earns its keep (`games/CLAUDE.md` for
   cross-framework game rules currently duplicated or globalized).

## Step 2: compile instead of symlink

Replace "one repo per audience" with fragments plus a compiler. A standards repo gains a
`fragments/` tree and a manifest:

```
fragments/
  core.md                  # everyone
  roles/dev.md             # merge rights, PR flow for devs
  roles/tester.md          # test-only workflow, never merge
  platforms/wsl.md         # binfmt, LAN-IP rules, CRLF
  platforms/windows.md
  frameworks/roblox.md
  tasks/web.md             # only for web-stack work
manifest.yml               # ordering, which axes apply at which target paths
```

`compile-context` (a script in `~/.claude/scripts`, invoked by bootstrap and sync) reads
a per-machine profile (`~/.claude/profile.yml`: member, role, platform, enabled
frameworks) and writes the actual `CLAUDE.md` files at the existing target paths.
Platform detection defaults from `uname`; role comes from the profile. Output files carry
a generated-do-not-edit header pointing at the fragment to change.

One interaction to design in, not around: `bootstrap.sh` force-recreates a symlink at
every `.ai-install.yml` target, and `sync.sh` re-runs it. Compiled targets must
therefore be removed from the repos' `targets:` blocks (or `create_symlinks()` taught to
skip any path the manifest marks as compiled); otherwise the next sync replaces every
generated file with a symlink again.

Properties this buys:

- A tester's machine bootstraps tester instructions from the same repos; nobody
  maintains parallel repos per person.
- Platform gotchas leave the monolithic global file and stop costing context on machines
  they do not apply to.
- Task-type scoping: skills and fragments list the frameworks/task types they apply to;
  the compiler only materializes what the profile enables (no threejs skills on a
  Roblox-only tester install).
- Codex parity for free: the compiler emits `AGENTS.md` targets from the same fragments,
  ending the hand-maintained subset drift.

Access control stays where it already is: GitHub repo permissions decide which fragment
repos a member can clone (bootstrap already skips inaccessible repos silently), and the
Atlas `encrypted` visibility pattern covers the rare shareable-but-sealed case.

## Step 3: dynamic per-task context (later, orchestrator-side)

Once launches flow through batch-launch, the orchestrator can append a task-scoped
context block to the generated prompt: the card, the project's naming chain (Roblox
display name vs repo folder vs engine demo path, the exact "hatch squishy pets" problem),
relevant Atlas highlights for the repo, and the review workflow the change class will
face. That is prompt assembly, not file generation, and it reuses the same fragments plus
the Atlas topic query. Prerequisite: the Atlas registry actually gets curated (it is
empty today); seed it with the ten active projects as part of phase 1 admin.

## Repo creation flow

Fold access grants into the existing create-repo endpoint: a `team` option that applies
a configured set of GitHub collaborator invitations (role-based lists in the profile
repo) at creation time, so "create the repo, then remember who to invite" stops being a
manual step.

## Non-goals

- No instruction content in this public repo; the compiler and fragments live in the
  private standards repos. This doc describes mechanism only.
- No runtime instruction server. Files on disk remain the delivery mechanism; agents and
  tools already know how to read them.
