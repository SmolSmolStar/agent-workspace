# 2026-08-24: Studio OS plan

Output of a research sweep (13 parallel scouts plus two PR-specific passes), synthesis,
and a three-model review round (Fable, Opus, Codex gpt-5.6-sol high; 47 findings, all
dispositioned). **`FINAL_IMPLEMENTATION_PLAN.md` is authoritative; where any other doc
here conflicts with it, it wins.** Read in this order:

0. `FINAL_IMPLEMENTATION_PLAN.md`, the build document: DAG, schemas, invariants, done criteria
1. `THE_PLAN_SIMPLE.md`, the whole thing on one page, plain words
1. `STUDIO_OS_MASTER_PLAN.md`, the plan: findings, architecture, seven phases
2. `CURRENT_STATE_INVENTORY.md`, verified audit: on/off/unmerged/broken/missing
3. `LANDING_THE_BRANCHES.md`, the PR train for the four big unmerged branches and three fix PRs
4. `TRELLO_STUDIO_OS.md`, Trello workspace shape, orchestrator config, the reminder loop
5. `PRIORITY_SCHEME.md`, P0-P3 definitions, time contracts, spoken aliases, the triage agent
6. `TEAM_VISIBILITY_AND_CROSS_MACHINE.md`, limits sharing, task hand-off, machine pairing
7. `CONTEXT_DISTRIBUTION.md`, role/platform/task-scoped instruction compilation
8. `GITHUB_PROJECTS_SWAP_ANALYSIS.md`, what changes if Trello is swapped for GitHub Projects v2, and the pilot plan

Private-system references (ADHD system, standards repos, board specifics) are kept at
architecture level; implementation details for those live in their own private repos.
