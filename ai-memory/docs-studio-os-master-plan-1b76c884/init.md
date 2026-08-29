# Studio OS master plan

## Request (condensed from voice transcript)
Build a master plan that unifies everything into one studio operating system:

Pain points:
- Team talks in Discord (text + screenshots), tasks get acknowledged then forgotten. No reminders, no deadlines, no priorities, no calendar. Real incident: 30-day reward in the meme-merge game never set up, user found it broken.
- Per-project Trello boards exist but are isolated. No central workspace, no due dates, no recurring cards, no cross-board rollup, no automations.
- Teammates' agents scrape Discord logs to figure out tasks (badly, images lost, confusion).
- No visibility into teammates' agent plans/limits (Claude/Fable/Codex/Grok); no way to assign a task+prompt to a teammate's machine.
- Voice input (ADHD system, Jarvis, Start Finishing) partially built but flaky, not hooked up to Trello or the orchestrator end to end.
- Desired routing ladder: exact-phrase fast path -> small local agent (qwen, tool use over Commander/Trello/ADHD APIs) -> larger router/orchestrator model (picks agent, model, effort, context based on remaining usage limits) -> real coding agent (Claude Code) doing implement/test/merge. Possibly routing across the user's two computers.
- CLAUDE.md/skills distribution: separate standards repos per layer works but is clunky; wants dynamic per-role (dev/tester), per-platform (windows/wsl/linux), per-task context generation; skills scoped to relevant stacks; repo-access management on repo creation.
- Review chains: criticality-tiered (minor = none, medium = one review, critical = multi-stage multi-lens: comments, code quality, data safety).
- PR queue system exists in orchestrator but is turned off; PR visibility UI is bad.
- Keep Trello as the data store (already paid, liked). ChatGPT advice pasted: single Trello workspace, Studio HQ board, standardized lists, workspace table/calendar, due-date automations, Discord ephemeral rule, WIP limits, weekly cadence.
- Research T3 Code for cross-machine task routing patterns.

Deliverable: massive implementation plan as PR on this repo (public repo: mark private/ADHD-specific parts optional). PLANS/2026-08-24/.

## Constraints
- Only Claude sub-agents (no Codex right now). Scouts on sonnet. Fable synthesizes.
- Minimal comments, unslop/stop-slop prose, no em dashes.
- Do not touch master/ (prod running on port 3000).
