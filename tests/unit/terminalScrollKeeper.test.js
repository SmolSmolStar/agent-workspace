const { TerminalScrollKeeper, SCROLL_KEEPER_DEFAULTS } = require('../../client/terminal-scroll-keeper');

function makeTerminal({ baseY = 100, viewportY = 100 } = {}) {
  const term = {
    buffer: { active: { baseY, viewportY } },
    scrollToBottomCalls: 0,
    scrollToBottom() {
      this.scrollToBottomCalls += 1;
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }
  };
  return term;
}

function makeElement() {
  return {
    listeners: new Map(),
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    removeEventListener(type) { this.listeners.delete(type); },
    fire(type) { this.listeners.get(type)?.(); }
  };
}

function makeKeeper({ snapBackSeconds = 60 } = {}) {
  let now = 1_000_000;
  const keeper = new TerminalScrollKeeper({
    getSnapBackSeconds: () => snapBackSeconds,
    now: () => now
  });
  return { keeper, advance: (ms) => { now += ms; } };
}

describe('TerminalScrollKeeper', () => {
  test('isNearBottom applies the follow tolerance', () => {
    const { keeper } = makeKeeper();
    expect(keeper.isNearBottom(makeTerminal({ baseY: 100, viewportY: 100 }))).toBe(true);
    expect(keeper.isNearBottom(makeTerminal({ baseY: 100, viewportY: 98 }))).toBe(true);
    expect(keeper.isNearBottom(makeTerminal({ baseY: 100, viewportY: 97 }))).toBe(false);
  });

  test('a viewport at the bottom is never touched', () => {
    const { keeper, advance } = makeKeeper();
    const term = makeTerminal();
    keeper.attach('s1', term, makeElement());
    advance(10 * 60 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);
  });

  test('a scrolled-up viewport snaps back only after the quiet period', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 60 });
    const term = makeTerminal({ baseY: 100, viewportY: 50 });
    const element = makeElement();
    keeper.attach('s1', term, element);

    keeper.tick(); // arms the countdown
    expect(term.scrollToBottomCalls).toBe(0);

    advance(30 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);

    advance(31 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(1);
    expect(keeper.isNearBottom(term)).toBe(true);
  });

  test('scroll activity restarts the countdown', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 60 });
    const term = makeTerminal({ baseY: 100, viewportY: 50 });
    const element = makeElement();
    keeper.attach('s1', term, element);

    keeper.tick();
    advance(55 * 1000);
    element.fire('wheel'); // user is still reading
    advance(30 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);

    advance(31 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(1);
  });

  test('a held mouse button (scrollbar drag) blocks the snap-back', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 60 });
    const term = makeTerminal({ baseY: 100, viewportY: 50 });
    const element = makeElement();
    keeper.attach('s1', term, element);

    keeper.tick();
    element.fire('mousedown');
    advance(10 * 60 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);

    keeper.handleDocumentMouseUp();
    advance(61 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(1);
  });

  test('snapBackSeconds of 0 disables the snap-back entirely', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 0 });
    const term = makeTerminal({ baseY: 100, viewportY: 0 });
    keeper.attach('s1', term, makeElement());
    advance(60 * 60 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);
  });

  test('returning to the bottom clears the armed countdown', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 60 });
    const term = makeTerminal({ baseY: 100, viewportY: 50 });
    keeper.attach('s1', term, makeElement());

    keeper.tick();
    term.buffer.active.viewportY = 100; // user scrolled back down themselves
    advance(61 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);

    // Scrolling up again starts a FRESH countdown, not the stale one
    term.buffer.active.viewportY = 40;
    keeper.tick();
    advance(30 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);
    advance(31 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(1);
  });

  test('detach removes listeners and stops managing the terminal', () => {
    const { keeper, advance } = makeKeeper({ snapBackSeconds: 60 });
    const term = makeTerminal({ baseY: 100, viewportY: 0 });
    const element = makeElement();
    keeper.attach('s1', term, element);
    keeper.detach('s1');
    expect(element.listeners.size).toBe(0);
    advance(10 * 60 * 1000);
    keeper.tick();
    expect(term.scrollToBottomCalls).toBe(0);
  });

  test('defaults are exposed for callers', () => {
    expect(SCROLL_KEEPER_DEFAULTS.snapBackSeconds).toBe(60);
    expect(SCROLL_KEEPER_DEFAULTS.followToleranceRows).toBe(2);
  });
});
