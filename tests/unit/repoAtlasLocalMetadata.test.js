const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractReadmeSummary,
  readLocalSummary
} = require('../../server/atlas/atlasLocalMetadata');

describe('Repo Atlas local metadata', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-local-metadata-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('prefers an explicit package description over README prose', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      description: '  Coordinates local coding sessions.  '
    }));
    fs.writeFileSync(path.join(root, 'README.md'), '# Workspace\n\nREADME fallback text.\n');

    expect(readLocalSummary(root)).toBe('Coordinates local coding sessions.');
  });

  test('extracts the first useful prose paragraph without badges or markup', () => {
    const readme = [
      '---',
      'title: Agent Workspace',
      '---',
      '# Agent Workspace',
      '[![build](https://img.example/build.svg)](https://ci.example)',
      '<div align="center">logo</div>',
      '',
      'Agent **Workspace** coordinates [local coding sessions](https://example.test).',
      'It keeps `worktrees` visible without sending repository metadata elsewhere.',
      '',
      '## Setup',
      'Ignore this paragraph.'
    ].join('\n');

    expect(extractReadmeSummary(readme, { repositoryName: 'Agent Workspace' })).toBe(
      'Agent Workspace coordinates local coding sessions. It keeps worktrees visible without sending repository metadata elsewhere.'
    );
  });

  test('skips headings, lists, code, tables, and title-only paragraphs', () => {
    const readme = [
      '# Fixture',
      '',
      'Fixture',
      '',
      '- fast',
      '- tested',
      '',
      '```sh',
      'npm start',
      '```',
      '',
      '| command | result |',
      '| --- | --- |',
      '',
      'A deterministic fixture used to test repository discovery behavior.'
    ].join('\n');

    expect(extractReadmeSummary(readme, { repositoryName: 'fixture' })).toBe(
      'A deterministic fixture used to test repository discovery behavior.'
    );
  });

  test('bounds long prose at a word boundary', () => {
    const readme = `# Long\n\n${'repeatable repository evidence '.repeat(20)}finishes here.\n`;
    const summary = extractReadmeSummary(readme);

    expect(summary.length).toBeLessThanOrEqual(280);
    expect(summary).toMatch(/\.\.\.$/);
    expect(summary).not.toMatch(/\s\.\.\.$/);
  });

  test('uses a case-insensitive README name and ignores malformed metadata', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{not-json');
    fs.writeFileSync(
      path.join(root, 'readme.MD'),
      '# Fixture\n\nReads repository metadata without changing the checkout.\n'
    );

    expect(readLocalSummary(root, { repositoryName: 'fixture' })).toBe(
      'Reads repository metadata without changing the checkout.'
    );
  });

  test('ignores placeholder metadata and falls back to README prose', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ description: '"' }));
    fs.writeFileSync(
      path.join(root, 'README.md'),
      '# Offline Server\n\nA self-contained knowledge server that runs without an internet connection.\n'
    );

    expect(readLocalSummary(root)).toBe(
      'A self-contained knowledge server that runs without an internet connection.'
    );
  });

  test('does not read a README symlink outside the checkout', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    fs.writeFileSync(outside, 'This text must stay outside repository discovery.\n');
    fs.symlinkSync(outside, path.join(root, 'README.md'));

    try {
      expect(readLocalSummary(root)).toBe('');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('rejects non-UTF-8 and null-delimited README content', () => {
    fs.writeFileSync(path.join(root, 'README.md'), Buffer.from([
      0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x58, 0x00
    ]));

    expect(readLocalSummary(root)).toBe('');
  });

  test('does not read an oversized README', () => {
    fs.writeFileSync(path.join(root, 'README.md'), Buffer.alloc(300 * 1024, 0x61));

    expect(readLocalSummary(root)).toBe('');
  });

  test('moves past a list-introducing fragment to complete prose', () => {
    const readme = [
      '# Research',
      '',
      'Compatibility research for:',
      '- first engine',
      '- second engine',
      '',
      'Documents the requirements for running games inside Discord activities.'
    ].join('\n');

    expect(extractReadmeSummary(readme)).toBe(
      'Documents the requirements for running games inside Discord activities.'
    );
  });

  test('keeps a substantive overview before its feature list', () => {
    const readme = [
      '# Orchestrator',
      '',
      'Coding agents now write substantial changes while engineers plan and review their work. The orchestrator keeps each task visible, enabling you to:',
      '- run agents in parallel',
      '- review each change',
      '',
      '## Installation',
      'Run the package manager.'
    ].join('\n');

    expect(extractReadmeSummary(readme)).toBe(
      'Coding agents now write substantial changes while engineers plan and review their work. The orchestrator keeps each task visible.'
    );
  });

  test('ignores generated-project and setup boilerplate', () => {
    const readme = [
      '# Fixture',
      '',
      'This project was created using bun init in bun.',
      '',
      'You can watch a video overview here.',
      '',
      'Each work folder is a git worktree for parallel development.',
      '',
      'A small multiplayer fixture for testing game-server changes.'
    ].join('\n');

    expect(extractReadmeSummary(readme)).toBe(
      'A small multiplayer fixture for testing game-server changes.'
    );
  });

  test('ignores wrapped badge explanations and list continuations', () => {
    const readme = [
      '# Physics Port',
      '',
      '[![gate](https://img.example/gate.svg)](https://ci.example)',
      '',
      'Two badges describe separate status claims:',
      '- per-push gate: every push runs the fast suite and',
      '  every game test covered by that gate.',
      '',
      'Neither badge is a required check on pull requests.',
      '',
      'A faithful physics engine port for games written in Luau.'
    ].join('\n');

    expect(extractReadmeSummary(readme, { repositoryName: 'physics-port' })).toBe(
      'A faithful physics engine port for games written in Luau.'
    );
  });

  test('removes a parenthesized bare URL without dangling punctuation', () => {
    const readme = [
      '# Archive',
      '',
      'Extracted archive of the asset gallery (`https://example.test/assets`).'
    ].join('\n');

    expect(extractReadmeSummary(readme)).toBe('Extracted archive of the asset gallery.');
  });

  test('returns no summary when the README has no prose', () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n\n- one\n- two\n');

    expect(readLocalSummary(root, { repositoryName: 'fixture' })).toBe('');
  });
});
