User: the Claude 5-hour usage in the header sat at 99% after the window should have
reset, while Claude Code's own /status showed nothing. Investigate, fix, PR.

Root cause: no code path invalidated a usage bucket once its resets_at passed. The
status-line tap file (~/.local/state/ai-usage-monitor/claude-live.json) is only
rewritten while a session is actively rendering its status line, so a window that
filled to 99% and blocked every session froze the tap at 99% indefinitely. The
OAuth merge in getClaudeLimits then grafted that dead bucket in whenever the live
payload omitted the session limit.
