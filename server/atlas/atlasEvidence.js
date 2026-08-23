const path = require('path');
const { execFile } = require('child_process');

const {
  checkoutCandidates,
  resolveCheckout
} = require('./atlasCheckout');
const {
  buildExamples,
  collectTouches,
  isTestPath,
  languageCounts,
  normalizeRepoPath,
  practiceSignals,
  sourceLanguage,
  splitNulls
} = require('./atlasCodeEvidence');
const { createEvidenceCoordinator } = require('./atlasEvidenceCoordinator');
const { repositorySlug } = require('./atlasIdentity');

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_EXAMPLE_LIMIT = 6;
const MAX_EXAMPLE_LIMIT = 12;
const MAX_CONCURRENT_ANALYSES = 2;

class GitInspectionError extends Error {
  constructor(detail, args, exitCode = null) {
    super('Repository evidence inspection failed.');
    this.name = 'GitInspectionError';
    this.detail = String(detail || 'unknown Git error');
    this.gitArgs = [...args];
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  }
}

function runGit(checkout, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', checkout, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(String(stdout || ''));
        return;
      }
      const detail = String(stderr || error.message || '').trim().split('\n')[0];
      reject(new GitInspectionError(detail, args, error.code));
    });
  });
}

function asPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function countAuthorIdentities(shortlog) {
  return String(shortlog || '').split('\n').filter((line) => line.trim()).length;
}

function earliestIsoDate(values) {
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || null;
}

function isMissingHeadError(error) {
  return error instanceof GitInspectionError
    && /(?:Needed a single revision|unknown revision|bad revision|ambiguous argument ['"]?HEAD)/i.test(error.detail);
}

async function inspectRepositoryEvidence(entry, options = {}, { runGitFn = runGit } = {}) {
  const repoId = String(entry?.id || entry?.repo || entry?.name || 'unknown');
  const candidateCount = checkoutCandidates(entry).length;
  const resolvedCheckout = await resolveCheckout(entry, { runGit: runGitFn });
  if (!resolvedCheckout) {
    return {
      repoId,
      available: false,
      reason: candidateCount > 0 && repositorySlug(entry)
        ? 'No local checkout matched this repository identity.'
        : 'No local Git checkout is available for this repository.'
    };
  }

  const checkout = resolvedCheckout.path;
  const historyLimit = asPositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 5_000);
  const exampleLimit = asPositiveInteger(options.maxExamples, DEFAULT_EXAMPLE_LIMIT, MAX_EXAMPLE_LIMIT);
  const insideWorktree = (await runGitFn(checkout, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (insideWorktree !== 'true') {
    return { repoId, available: false, reason: 'The selected checkout is not a Git worktree.' };
  }
  try {
    await runGitFn(checkout, ['rev-parse', '--verify', 'HEAD']);
  } catch (error) {
    if (isMissingHeadError(error)) {
      return { repoId, available: false, reason: 'The local Git checkout has no commits.' };
    }
    throw error;
  }

  const [
    commitCountOutput,
    shortlog,
    latestCommitAt,
    rootHashesOutput,
    tagsOutput,
    trackedOutput,
    touchLog
  ] = await Promise.all([
    runGitFn(checkout, ['rev-list', '--count', 'HEAD']),
    runGitFn(checkout, ['shortlog', '-sn', 'HEAD']),
    runGitFn(checkout, ['log', '-1', '--format=%cI', 'HEAD']),
    runGitFn(checkout, ['rev-list', '--max-parents=0', 'HEAD']),
    runGitFn(checkout, ['for-each-ref', '--merged', 'HEAD', '--sort=-creatordate', '--format=%(refname:short)', 'refs/tags']),
    runGitFn(checkout, ['ls-files', '-z']),
    runGitFn(checkout, ['log', '-n', String(historyLimit), '--format=', '--name-only', '-z', '--no-renames'])
  ]);

  const rootHashes = rootHashesOutput.split(/\s+/).filter(Boolean);
  const rootDatesOutput = rootHashes.length
    ? await runGitFn(checkout, ['show', '-s', '--format=%cI', ...rootHashes])
    : '';
  const trackedFiles = splitNulls(trackedOutput)
    .map((repoPath) => normalizeRepoPath(repoPath, { allowBackslash: false }))
    .filter(Boolean);
  const sourceFiles = trackedFiles.filter((repoPath) => sourceLanguage(repoPath) && !isTestPath(repoPath));
  const testFiles = trackedFiles.filter((repoPath) => sourceLanguage(repoPath) && isTestPath(repoPath));
  const knownSourceFiles = new Set([...sourceFiles, ...testFiles]);
  const touches = collectTouches(touchLog, knownSourceFiles);
  const commitCount = Number(commitCountOutput.trim()) || 0;
  const tags = tagsOutput.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);

  return {
    repoId,
    available: true,
    checkout: {
      resolution: resolvedCheckout.resolution
    },
    history: {
      commitCount,
      authorIdentityCount: countAuthorIdentities(shortlog),
      firstCommitAt: earliestIsoDate(rootDatesOutput.split(/\r?\n/)),
      lastCommitAt: latestCommitAt.trim() || null,
      tagCount: tags.length,
      latestTagByCreatorDate: tags[0] || null,
      sampledCommitCount: Math.min(commitCount, historyLimit)
    },
    code: {
      trackedFiles: trackedFiles.length,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      testToSourceRatio: sourceFiles.length ? Number((testFiles.length / sourceFiles.length).toFixed(2)) : null,
      languages: languageCounts(sourceFiles, testFiles)
    },
    practices: practiceSignals(trackedFiles, testFiles),
    examples: buildExamples({
      entry,
      checkout,
      sourceFiles,
      testFiles,
      touches,
      limit: exampleLimit
    })
  };
}

function analysisKey(entry, options = {}) {
  const paths = [entry?.localPath, ...(Array.isArray(entry?.localPaths) ? entry.localPaths : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .sort();
  const highlights = (Array.isArray(entry?.highlights) ? entry.highlights : []).map((highlight) => ({
    topic: String(highlight?.topic || ''),
    quality: Number.isFinite(Number(highlight?.quality)) ? Number(highlight.quality) : null,
    paths: (Array.isArray(highlight?.paths) ? highlight.paths : []).map(String)
  }));
  return JSON.stringify({
    repo: repositorySlug(entry).toLowerCase(),
    id: String(entry?.id || entry?.name || ''),
    paths,
    worktreeLayout: entry?.worktreeLayout === true,
    highlights,
    historyLimit: asPositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 5_000),
    exampleLimit: asPositiveInteger(options.maxExamples, DEFAULT_EXAMPLE_LIMIT, MAX_EXAMPLE_LIMIT)
  });
}

function createRepositoryEvidenceAnalyzer({
  runGitFn = runGit,
  maxConcurrent = MAX_CONCURRENT_ANALYSES
} = {}) {
  const coordinator = createEvidenceCoordinator({ maxConcurrent });
  return (entry, options = {}) => coordinator.run(
    analysisKey(entry, options),
    () => inspectRepositoryEvidence(entry, options, { runGitFn })
  );
}

const defaultAnalyzer = createRepositoryEvidenceAnalyzer();
const analyzeRepositoryEvidence = (entry, options = {}) => defaultAnalyzer(entry, options);

function formatRepositoryEvidence(report) {
  if (!report.available) return `${report.repoId}: ${report.reason}`;
  const { history, code, practices } = report;
  const lines = [
    report.repoId,
    `checkout       ${report.checkout.resolution}`,
    `history        ${history.commitCount} commits | ${history.authorIdentityCount} author identities | ${history.tagCount} tags`,
    `activity       ${history.firstCommitAt || 'unknown'} to ${history.lastCommitAt || 'unknown'}`,
    `code           ${code.sourceFiles} source | ${code.testFiles} test | ${code.trackedFiles} tracked`,
    `test ratio     ${code.testToSourceRatio === null ? 'n/a' : code.testToSourceRatio}`,
    `languages      ${code.languages.map((row) => `${row.language} ${row.files}`).join(' | ') || 'none detected'}`,
    `signals        CI ${practices.ciConfigCount} | codebase docs ${practices.hasCodebaseDocumentation ? 'yes' : 'no'} | instructions ${practices.hasAgentInstructions ? 'yes' : 'no'} | lockfile ${practices.hasDependencyLockfile ? 'yes' : 'no'}`
  ];
  if (history.latestTagByCreatorDate) lines.push(`recent tag     ${history.latestTagByCreatorDate}`);
  if (report.examples.length) {
    lines.push('', `representative paths (touches sampled across ${history.sampledCommitCount} commits)`);
    for (const example of report.examples) {
      const curated = example.curated
        ? ` | curated ${example.curated.topic}${example.curated.quality === null ? '' : ` ${example.curated.quality}/5`}`
        : '';
      const linesLabel = example.nonBlankLines === null ? 'size unavailable' : `${example.nonBlankLines} nonblank lines`;
      lines.push(`  ${example.path} | ${example.kind} | ${example.recentCommitTouches} touches | ${linesLabel}${curated}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  analyzeRepositoryEvidence,
  createRepositoryEvidenceAnalyzer,
  formatRepositoryEvidence,
  GitInspectionError,
  normalizeRepoPath,
  runGit,
  isTestPath
};
