# Root cause (overlay)
statusDetector's shell-prompt heuristic counts a bare ">" or "❯" line as an explicit
shell indicator. During the oversized-pane garbling (fixed in #1101), wrapped Claude UI
matched it, sessionManager.refreshSessionStatus called markAgentInactive, recovery
lastAgent went null (verified in ~/.agent-workspace/session-recovery/fresh-start.json for
box2d-luau-work2-claude), and shouldShowStartupUI's session.agent guard stopped working →
overlay shows on every idle→waiting flicker.

# Fix
- tmuxSessionBackend.paneCurrentCommand(): pane_current_command ground truth.
- sessionManager.paneStillRunsAgent(): tmux-backed sessions skip the marker clear when
  the pane's foreground command is not a plain shell (SHELL_FOREGROUND_COMMANDS set).
- commander-panel fitTerminalSoon: instance snapshot guard so a tab switch during the two
  rAF hops cannot push one tab's size onto another tab's PTY.
- Data repair at deploy: restore lastAgent=claude/lastAgentActive=true for
  box2d-luau-work2-claude in the recovery file while the server is paused.

# Verification
5 new jest tests (paneCurrentCommand + guard verdicts); full suite 1005/1005.
