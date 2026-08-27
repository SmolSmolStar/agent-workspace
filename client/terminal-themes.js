// Shared xterm.js color themes — the single source of truth for every
// terminal surface (worktree terminals via TerminalManager, the Commander
// panel, and anything else that spawns an xterm instance). Previously each
// surface kept its own copy of these objects; Commander's copy silently
// drifted out of the light/dark theme-switch path (`updateTheme()` only
// ever touched TerminalManager's terminals), so toggling the app theme left
// Commander's terminal stuck on whichever palette it was constructed with —
// including diff colors tuned for the wrong background.
window.TERMINAL_THEMES = {
  dark: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#c9d1d9',
    cursorAccent: '#0d1117',
    selection: 'rgba(88, 166, 255, 0.3)',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  },
  light: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#24292f',
    cursorAccent: '#ffffff',
    selection: 'rgba(9, 105, 218, 0.3)',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  }
};

// `theme === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.dark`, but
// named so every call site reads the same way instead of re-deriving it.
window.getTerminalTheme = function getTerminalTheme(theme) {
  return theme === 'light' ? window.TERMINAL_THEMES.light : window.TERMINAL_THEMES.dark;
};

// Shared xterm construction options — the single source of truth for how every
// terminal surface looks and behaves (font, cursor, scrollback, selection).
// Worktree terminals and the Commander panel each used to hand-copy this object,
// which is exactly how visual drift between them starts.
window.TERMINAL_BASE_OPTIONS = {
  fontSize: 12,
  fontFamily: 'Consolas, Monaco, "Courier New", monospace',
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 5000,
  tabStopWidth: 4,
  bellStyle: 'none',
  allowTransparency: false,
  convertEol: false,  // CRITICAL: don't convert \r to \r\n — needed for spinner animations
  wordSeparator: ' ()[]{}\'"',
  rightClickSelectsWord: true
  // NOTE: xterm 5.x removed the `rendererType`/`experimentalCharAtlas` options.
  // The renderer is selected by loading the Canvas addon after open() at each
  // call site (the DOM renderer intermittently leaves garbled rows).
};

// Fresh options object (never a shared reference xterm could mutate) with the
// palette for the requested app theme baked in.
window.getTerminalOptions = function getTerminalOptions(theme) {
  return { ...window.TERMINAL_BASE_OPTIONS, theme: window.getTerminalTheme(theme) };
};
