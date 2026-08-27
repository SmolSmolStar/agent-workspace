# Plan

## Root cause (investigated in master/ read-only)
client/terminal.js handleOutput() called terminal.scrollToBottom() on every output chunk
unless a `userScrolling` flag was set. The flag was maintained by wheel/mousedown events
plus a checkScrollPosition() 100ms later that CLEARED it whenever the viewport was within
5 rows of the bottom. While an agent streams (output chunks every few ms), a user
scrolling up from the bottom is still inside that 5-row zone when the check fires, the
flag clears, and the next chunk yanks them down — repeat forever. Scrollbar detection was
a `rect.right - 20` guess; touch scrolling was never tracked at all (mobile always yanked).

Verified live: current Claude Code (2.1.220) panes have NO mouse tracking and NO alt
screen (tmux pane flags all 0), and the tmux backend disables the outer alt screen
(smcup@/rmcup@), so wheel scrolls xterm's native buffer — the yank is purely this client
logic. Commander panel has no forced scroll (native xterm follow), so it never yanked but
could strand a forgotten scroll-up. Codex/Grok/OpenCode TUIs run in the pane's inner alt
screen; same handleOutput path applied, same fix covers them.

## Fix
1. New client/terminal-scroll-keeper.js — TerminalScrollKeeper:
   - isNearBottom(terminal): baseY - viewportY <= 2 (follow tolerance).
   - attach(key, term, element): wheel/mousedown/touch listeners record activity;
     document mouseup ends drags; noteActivity(key) for keyboard scrolling.
   - 5s interval tick: viewport scrolled up + no activity for snapBackSeconds
     (settings.scrollSnapBackSeconds, default 60, 0 disables) → scrollToBottom().
     Countdown arms from the first scrolled-up sighting (programmatic scroll-to-top
     gets the full grace period). Held mouse button blocks snap-back.
2. client/terminal.js: handleOutput samples isNearBottom BEFORE write and scrolls in the
   write callback only if it was at the bottom. Removed userScrolling map,
   checkScrollPosition, wheel/scrollbar heuristics, dead terminalScrollStates map.
3. client/commander-panel.js: attach keeper per Commander instance (snap-back only;
   native follow already correct). Detach on closeTab.
4. client/app.js: settings default scrollSnapBackSeconds: 60; removed userScrolling
   reset in review-console layout (scrollToBottom alone suffices now).
5. client/index.html: load terminal-scroll-keeper.js before commander-panel/terminal.
6. tests/unit/terminalScrollKeeper.test.js — 9 jest tests, injected clock.
