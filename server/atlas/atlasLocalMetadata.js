const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const MAX_METADATA_BYTES = 128 * 1024;
const MAX_README_BYTES = 256 * 1024;
const MAX_SUMMARY_CHARS = 280;
const METADATA_FILES = ['package.json', 'composer.json', 'deno.json'];
const README_NAMES = ['readme.md', 'readme.markdown', 'readme.rst', 'readme.txt', 'readme'];
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function readRegularFile(filePath, maxBytes) {
  let descriptor = null;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maxBytes) return null;

    const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile() || descriptorStat.size > maxBytes) return null;

    const buffer = Buffer.alloc(descriptorStat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const contents = buffer.subarray(0, offset);
    if (contents.includes(0)) return null;
    return UTF8_DECODER.decode(contents);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is already unusable.
      }
    }
  }
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function normalizeSummary(value, { maxChars = MAX_SUMMARY_CHARS } = {}) {
  const cleaned = decodeEntities(String(value || ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/[^\s<>()`]+/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[~*_]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+[(\[{]+$/g, '')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
  if (!cleaned || cleaned.length <= maxChars) return cleaned;

  const target = Math.max(1, maxChars - 3);
  const wordBoundary = cleaned.lastIndexOf(' ', target);
  const boundary = wordBoundary >= Math.floor(target * 0.6) ? wordBoundary : target;
  return `${cleaned.slice(0, boundary).trimEnd().replace(/[,:;]+$/, '')}...`;
}

function comparableLabel(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function usefulReadmeParagraph(paragraph, repositoryName) {
  let summary = normalizeSummary(paragraph);
  if (summary.length < 20) return '';
  const words = summary.match(/[\p{L}\p{N}][\p{L}\p{N}+#'.-]*/gu) || [];
  if (words.length < 4) return '';
  if (repositoryName && comparableLabel(summary) === comparableLabel(repositoryName)) return '';
  if (summary.endsWith(':')) {
    if (summary.length < 100) return '';
    const trailingClause = summary.lastIndexOf(',');
    summary = trailingClause >= 60 && summary.length - trailingClause <= 40
      ? `${summary.slice(0, trailingClause)}.`
      : `${summary.slice(0, -1)}.`;
  }
  if (/\b(?:badges?|required checks?|pull requests?)\b/i.test(summary)) return '';
  if (/^this project was created (?:using|with)\b/i.test(summary)) return '';
  if (/^(?:you can\s+)?watch (?:a|the) video\b/i.test(summary)) return '';
  if (/^(?:start|see|read|visit|click)\b.*\b(?:docs?|documentation|guide|here)\b/i.test(summary)) return '';
  if (/\bgit worktrees? for parallel development\b/i.test(summary)) return '';
  if (/\b(?:coming soon|isn't written yet|is not written yet|hasn't been written yet)\b/i.test(summary)) return '';
  return summary;
}

function extractReadmeSummary(contents, { repositoryName = '' } = {}) {
  const lines = String(contents || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const paragraphs = [];
  let paragraph = [];
  let inFence = false;
  let inFrontMatter = lines[0]?.trim() === '---';
  let inHtmlComment = false;
  let htmlBlockTag = '';
  let inListBlock = false;

  const flush = () => {
    if (paragraph.length) paragraphs.push(paragraph.join(' '));
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    if (inHtmlComment) {
      if (trimmed.includes('-->')) inHtmlComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      flush();
      inHtmlComment = !trimmed.includes('-->');
      continue;
    }
    if (htmlBlockTag) {
      if (new RegExp(`</${htmlBlockTag}\\s*>`, 'i').test(trimmed)) htmlBlockTag = '';
      continue;
    }
    const htmlBlock = trimmed.match(/^<(div|p|picture|table|details|summary|center)\b/i);
    if (htmlBlock) {
      flush();
      if (!new RegExp(`</${htmlBlock[1]}\\s*>`, 'i').test(trimmed)) {
        htmlBlockTag = htmlBlock[1];
      }
      continue;
    }
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) {
      flush();
      inListBlock = false;
      continue;
    }
    if (inListBlock) continue;

    const startsListBlock = /^(?:[-+*]|\d+[.)])\s+/.test(trimmed)
      || /^>/.test(trimmed)
      || line.startsWith('    ');
    const isStructural = /^#{1,6}\s/.test(trimmed)
      || /^[-=~_^]{3,}$/.test(trimmed)
      || startsListBlock
      || /^\[![^\]]*\]/.test(trimmed)
      || /^!\[[^\]]*\]/.test(trimmed)
      || /^\[[^\]]+\]:\s*\S+/.test(trimmed)
      || /^\.\.\s+\S+::/.test(trimmed)
      || trimmed.startsWith('|');
    if (isStructural) {
      flush();
      inListBlock = startsListBlock;
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();

  for (const candidate of paragraphs) {
    const summary = usefulReadmeParagraph(candidate, repositoryName);
    if (summary) return summary;
  }
  return '';
}

function jsonMetadataSummary(checkout) {
  for (const filename of METADATA_FILES) {
    const contents = readRegularFile(path.join(checkout, filename), MAX_METADATA_BYTES);
    if (contents === null) continue;
    try {
      const metadata = JSON.parse(contents);
      if (typeof metadata?.description !== 'string') continue;
      const summary = normalizeSummary(metadata.description);
      const words = summary.match(/[\p{L}\p{N}][\p{L}\p{N}+#'.-]*/gu) || [];
      if (summary.length >= 12 && words.length >= 2) return summary;
    } catch {
      // Try the next metadata source.
    }
  }
  return '';
}

function readmeSummary(checkout, repositoryName) {
  let names = [];
  try {
    names = fs.readdirSync(checkout).sort();
  } catch {
    return '';
  }

  for (const preferredName of README_NAMES) {
    for (const name of names.filter((candidate) => candidate.toLowerCase() === preferredName)) {
      const contents = readRegularFile(path.join(checkout, name), MAX_README_BYTES);
      if (contents === null) continue;
      const summary = extractReadmeSummary(contents, { repositoryName });
      if (summary) return summary;
    }
  }
  return '';
}

function readLocalSummary(checkout, { repositoryName = path.basename(checkout) } = {}) {
  return jsonMetadataSummary(checkout) || readmeSummary(checkout, repositoryName);
}

module.exports = {
  MAX_SUMMARY_CHARS,
  extractReadmeSummary,
  normalizeSummary,
  readLocalSummary
};
