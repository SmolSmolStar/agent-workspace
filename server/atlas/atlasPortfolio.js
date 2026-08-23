const {
  analyzeRepositoryEvidence,
  formatRepositoryEvidence
} = require('./atlasEvidence');

const DEFAULT_REPOSITORY_LIMIT = 10;
const MAX_REPOSITORY_LIMIT = 50;
const EVIDENCE_CONCURRENCY = 2;

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function hasLocalCheckout(entry) {
  return entry?.cloned === true
    || Boolean(String(entry?.localPath || '').trim())
    || (Array.isArray(entry?.localPaths) && entry.localPaths.some((value) => String(value || '').trim()));
}

function qualityScore(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function repositoryMetadata(entry) {
  return {
    id: String(entry?.id || ''),
    name: String(entry?.name || entry?.id || ''),
    repo: String(entry?.repo || ''),
    summary: String(entry?.summary || ''),
    kind: String(entry?.kind || ''),
    status: String(entry?.status || ''),
    maturity: String(entry?.maturity || ''),
    platforms: Array.isArray(entry?.platforms) ? [...entry.platforms] : [],
    languages: Array.isArray(entry?.languages) ? [...entry.languages] : [],
    tags: Array.isArray(entry?.tags) ? [...entry.tags] : [],
    quality: qualityScore(entry?.quality)
  };
}

async function analyzeConcurrently(entries, analyzeFn, options) {
  const results = new Array(entries.length);
  let cursor = 0;
  let failure = null;

  const worker = async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      try {
        results[index] = await Promise.resolve().then(() => analyzeFn(entries[index], options));
      } catch (error) {
        if (!failure || index < failure.index) failure = { index, error };
      }
    }
  };

  const workerCount = Math.min(EVIDENCE_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure) throw failure.error;
  return results;
}

async function createPortfolioReport(entries, options = {}, {
  analyzeFn = analyzeRepositoryEvidence
} = {}) {
  const includeRemote = options.includeRemote === true;
  const source = Array.isArray(entries) ? entries : [];
  const eligible = includeRemote ? source : source.filter(hasLocalCheckout);
  const limit = boundedInteger(options.limit, DEFAULT_REPOSITORY_LIMIT, MAX_REPOSITORY_LIMIT);
  const selected = eligible.slice(0, limit);
  const evidence = await analyzeConcurrently(selected, analyzeFn, {
    maxExamples: options.maxExamples
  });

  return {
    includeRemote,
    eligibleCount: eligible.length,
    repositoryCount: selected.length,
    omittedCount: Math.max(0, eligible.length - selected.length),
    repositories: selected.map((entry, index) => ({
      repository: repositoryMetadata(entry),
      evidence: evidence[index]
    }))
  };
}

function formatPortfolioReport(report) {
  const scope = report.includeRemote ? 'matching repositories' : 'matching local repositories';
  const lines = [
    'Repository evidence report',
    `${report.repositoryCount} of ${report.eligibleCount} ${scope}`
  ];
  if (report.omittedCount > 0) lines.push(`${report.omittedCount} omitted by the report limit`);

  for (const row of report.repositories) {
    const metadata = row.repository;
    lines.push('', metadata.id || metadata.name || 'unknown repository');
    if (metadata.summary) lines.push(`  summary        ${metadata.summary}`);
    const classification = [metadata.kind, metadata.status, metadata.maturity].filter(Boolean).join(' | ');
    if (classification) lines.push(`  classification ${classification}`);
    if (metadata.platforms.length) lines.push(`  platforms      ${metadata.platforms.join(', ')}`);
    if (!row.evidence.available) {
      lines.push(`  evidence       ${row.evidence.reason}`);
      continue;
    }
    const evidenceLines = formatRepositoryEvidence(row.evidence).split('\n').slice(1);
    for (const line of evidenceLines) lines.push(line ? `  ${line}` : '');
  }

  return lines.join('\n');
}

module.exports = {
  createPortfolioReport,
  formatPortfolioReport,
  DEFAULT_REPOSITORY_LIMIT,
  MAX_REPOSITORY_LIMIT
};
