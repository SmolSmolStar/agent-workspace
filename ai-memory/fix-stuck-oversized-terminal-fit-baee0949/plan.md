# Root causes (verified live on prod)

1. Stuck oversized PTY: fitTerminal's lastGoodPtyDimensions ratchet (refuse fits below 60%
   of last good) gets poisoned by one legitimate oversized fit (full-width container measured
   mid-layout after reload, or focused single-terminal view records 385x92). Every later
   correct ~74-col fit is below the 231-col ratchet -> refused after 5 retries, forever
   (heal sweep re-refuses every 15s). PTY + xterm stay 385 cols while the tile is ~74 ->
   TUI frames wrap ~5x = "five copies". Confirmed: tmux pane adhd-system-work2-claude 385x92
   while a fresh client fits 74x66; my test client resized other panes fine, adhd's owner
   browser kept re-asserting 385x92.
2. Commander: only the FIRST instance's container ever got a ResizeObserver
   (`!this.resizeObserver` guard), so panel drag-resize never refit cmd-2+; window-resize
   listener also stacked once per initTerminal call.

# Fix
- terminal.js: pendingSmallFits per session counts consecutive identical below-ratchet
  proposals (>= minPty dims only); after stableSmallFitConfirmations (3) identical
  proposals the down-fit is accepted and lastGood updated. 0x0/tiny stays refused. State
  cleaned up on session dispose (+ lastGoodPtyDimensions).
- commander-panel.js: resizeObservers Map keyed by instance id, one observer per tab
  container, gated on that tab being active; disconnected in closeTab. Window resize
  listener registered once via windowResizeHandler.
