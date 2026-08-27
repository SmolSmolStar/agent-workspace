// TerminalScrollKeeper — decides when a terminal viewport may return to the bottom.
//
// The rule set it implements:
//   - A viewport at (or within followToleranceRows of) the bottom follows new output.
//     The write path asks isNearBottom() BEFORE writing and scrolls after.
//   - A viewport the user scrolled up stays exactly where they put it, no matter how
//     much output streams in underneath.
//   - A viewport left scrolled up with no wheel/drag/touch/key activity for
//     snapBackSeconds is returned to the bottom, so a forgotten scroll-up never
//     strands the terminal in history.
//
// One keeper instance manages many terminals (attach/detach by key). It owns the
// generic DOM activity listeners (wheel, mousedown, touch); keyboard scrolling goes
// through xterm's key handler, so callers report it via noteActivity(key).

const SCROLL_KEEPER_DEFAULTS = {
  snapBackSeconds: 60,
  checkIntervalMs: 5000,
  followToleranceRows: 2
};

// Single translation from orchestrator settings to a snap-back duration, shared by
// every terminal surface (worktree terminals, Commander panel). autoScroll off or
// scrollSnapBackSeconds <= 0 disables the snap-back.
function snapBackSecondsFromSettings(settings) {
  if (!settings || settings.autoScroll === false) return 0;
  const seconds = Number(settings.scrollSnapBackSeconds);
  return Number.isFinite(seconds) ? seconds : SCROLL_KEEPER_DEFAULTS.snapBackSeconds;
}

class TerminalScrollKeeper {
  constructor(options = {}) {
    this.getSnapBackSeconds = typeof options.getSnapBackSeconds === 'function'
      ? options.getSnapBackSeconds
      : () => SCROLL_KEEPER_DEFAULTS.snapBackSeconds;
    this.followToleranceRows = Number.isFinite(options.followToleranceRows)
      ? options.followToleranceRows
      : SCROLL_KEEPER_DEFAULTS.followToleranceRows;
    this.checkIntervalMs = Number.isFinite(options.checkIntervalMs)
      ? options.checkIntervalMs
      : SCROLL_KEEPER_DEFAULTS.checkIntervalMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.entries = new Map();
    this.timer = null;

    // One shared mouseup listener: a scrollbar drag ends anywhere on the page,
    // not necessarily over the terminal that started it.
    this.handleDocumentMouseUp = () => {
      for (const entry of this.entries.values()) {
        if (entry.pointerDown) {
          entry.pointerDown = false;
          entry.lastActivityAt = this.now();
        }
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('mouseup', this.handleDocumentMouseUp);
    }
  }

  start() {
    if (this.timer || !(this.checkIntervalMs > 0)) return;
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  attach(key, terminal, element) {
    if (!key || !terminal) return;
    this.detach(key);
    const entry = {
      terminal,
      element: element || null,
      lastActivityAt: 0,
      scrolledUpSince: 0,
      pointerDown: false,
      listeners: []
    };
    if (element && typeof element.addEventListener === 'function') {
      const activity = () => this.noteActivity(key);
      const pointerDown = () => {
        entry.pointerDown = true;
        entry.lastActivityAt = this.now();
      };
      const passive = { passive: true };
      entry.listeners = [
        ['wheel', activity, passive],
        ['mousedown', pointerDown, undefined],
        ['touchstart', activity, passive],
        ['touchmove', activity, passive]
      ];
      for (const [type, handler, opts] of entry.listeners) {
        element.addEventListener(type, handler, opts);
      }
    }
    this.entries.set(key, entry);
  }

  detach(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.element && typeof entry.element.removeEventListener === 'function') {
      for (const [type, handler, opts] of entry.listeners) {
        entry.element.removeEventListener(type, handler, opts);
      }
    }
    this.entries.delete(key);
  }

  noteActivity(key) {
    const entry = this.entries.get(key);
    if (entry) entry.lastActivityAt = this.now();
  }

  scrollOffsetRows(terminal) {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return 0;
    return Math.max(0, buffer.baseY - buffer.viewportY);
  }

  isNearBottom(terminal) {
    return this.scrollOffsetRows(terminal) <= this.followToleranceRows;
  }

  tick() {
    const seconds = Number(this.getSnapBackSeconds());
    const snapBackMs = seconds > 0 ? seconds * 1000 : 0;
    if (!snapBackMs) return;
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.pointerDown) continue;
      if (this.isNearBottom(entry.terminal)) {
        entry.scrolledUpSince = 0;
        continue;
      }
      // First tick that sees a scrolled-up viewport arms the countdown from NOW,
      // never from a stale timestamp — a programmatic scroll-to-top (voice
      // command, restored session) must get the full grace period, not an
      // instant yank.
      if (!entry.scrolledUpSince) entry.scrolledUpSince = now;
      const anchor = Math.max(entry.scrolledUpSince, entry.lastActivityAt);
      if (now - anchor >= snapBackMs) {
        entry.terminal.scrollToBottom?.();
        entry.scrolledUpSince = 0;
      }
    }
  }

  dispose() {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleDocumentMouseUp);
    }
    for (const key of Array.from(this.entries.keys())) {
      this.detach(key);
    }
  }
}

// Build + start a keeper wired to live settings — the one constructor call sites use.
TerminalScrollKeeper.forSettings = function forSettings(getSettings) {
  const keeper = new TerminalScrollKeeper({
    getSnapBackSeconds: () => snapBackSecondsFromSettings(getSettings?.())
  });
  keeper.start();
  return keeper;
};

if (typeof window !== 'undefined') {
  window.TerminalScrollKeeper = TerminalScrollKeeper;
  window.SCROLL_KEEPER_DEFAULTS = SCROLL_KEEPER_DEFAULTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TerminalScrollKeeper, SCROLL_KEEPER_DEFAULTS, snapBackSecondsFromSettings };
}
