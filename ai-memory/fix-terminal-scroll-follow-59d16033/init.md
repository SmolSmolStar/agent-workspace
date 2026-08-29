# User request

Terminals (worktree Claude sessions, e.g. adhd-system work2) keep yanking the view to the
bottom while the user scrolls up. Requirements:
- Keep following output at the bottom in general.
- If the user deliberately scrolls up (scrollbar or wheel), leave them alone.
- If they scroll up and forget, auto-return to the bottom after ~1 minute.
- Avoid the older opposite failure: view stuck at the top, never recovering.
- Check the same behavior for Codex, Grok, and OpenCode terminals.
