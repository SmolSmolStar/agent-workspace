function atlasPortfolioRenderText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function atlasPortfolioRenderList(value) {
  return Array.isArray(value) ? value : [];
}

function atlasPortfolioRenderEscape(value) {
  return atlasPortfolioRenderText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

class AtlasPortfolioRenderer {
  number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  renderReportHtml(report) {
    const rows = atlasPortfolioRenderList(report?.repositories);
    const count = this.number(report?.repositoryCount, rows.length);
    const eligible = this.number(report?.eligibleCount, count);
    const omitted = this.number(report?.omittedCount);
    const scope = report?.includeRemote === true ? 'Local and remote entries' : 'Local checkouts only';
    const cards = rows.map((row) => this.renderRepositoryHtml(row)).join('');

    return `
      <div class="atlas-portfolio-summary">
        <div><strong>${count}</strong><span>Analyzed</span></div>
        <div><strong>${eligible}</strong><span>Eligible</span></div>
        <div><strong>${omitted}</strong><span>Outside limit</span></div>
        <div><strong>${atlasPortfolioRenderEscape(scope)}</strong><span>Scope</span></div>
      </div>
      <div class="atlas-portfolio-grid">
        ${cards || '<div class="atlas-portfolio-empty">No repositories matched these filters.</div>'}
      </div>
    `;
  }

  renderRepositoryHtml(row) {
    const repository = row?.repository || {};
    const evidence = row?.evidence || {};
    const name = atlasPortfolioRenderText(repository.name || repository.id) || 'Unnamed repository';
    const slug = atlasPortfolioRenderText(repository.repo);
    const summary = atlasPortfolioRenderText(repository.summary);
    const chips = [
      repository.kind,
      repository.status,
      repository.maturity,
      ...atlasPortfolioRenderList(repository.platforms),
      ...atlasPortfolioRenderList(repository.languages)
    ].map(atlasPortfolioRenderText).filter(Boolean);
    if (repository.quality !== null && repository.quality !== undefined) {
      chips.push(`Quality ${repository.quality}/5`);
    }

    return `
      <article class="atlas-portfolio-card">
        <header>
          <div>
            <h4>${atlasPortfolioRenderEscape(name)}</h4>
            ${slug ? `<div class="atlas-portfolio-slug">${atlasPortfolioRenderEscape(slug)}</div>` : ''}
          </div>
          <div class="atlas-portfolio-chips">
            ${chips.map((chip) => `<span>${atlasPortfolioRenderEscape(chip)}</span>`).join('')}
          </div>
        </header>
        ${summary ? `<p class="atlas-portfolio-description">${atlasPortfolioRenderEscape(summary)}</p>` : ''}
        ${evidence.available === true
          ? this.renderEvidenceHtml(evidence)
          : `<div class="atlas-portfolio-unavailable">${atlasPortfolioRenderEscape(evidence.reason || 'No local Git evidence is available.')}</div>`}
      </article>
    `;
  }

  renderEvidenceHtml(evidence) {
    const history = evidence.history || {};
    const code = evidence.code || {};
    const practices = evidence.practices || {};
    const ratio = code.testToSourceRatio === null || code.testToSourceRatio === undefined
      ? 'n/a'
      : atlasPortfolioRenderText(code.testToSourceRatio);
    const metrics = [
      ['Commits', this.number(history.commitCount)],
      ['Authors', this.number(history.authorIdentityCount)],
      ['Source files', this.number(code.sourceFiles)],
      ['Test files', this.number(code.testFiles)],
      ['Test ratio', ratio],
      ['Tags', this.number(history.tagCount)]
    ];
    const signals = [
      ['Tests', practices.hasTests],
      ['CI', this.number(practices.ciConfigCount) > 0],
      ['Codebase docs', practices.hasCodebaseDocumentation],
      ['Agent instructions', practices.hasAgentInstructions],
      ['Lockfile', practices.hasDependencyLockfile]
    ];
    const languages = atlasPortfolioRenderList(code.languages);
    const examples = atlasPortfolioRenderList(evidence.examples);

    return `
      <div class="atlas-portfolio-metrics">
        ${metrics.map(([label, value]) => `
          <div><span>${atlasPortfolioRenderEscape(label)}</span><strong>${atlasPortfolioRenderEscape(value)}</strong></div>
        `).join('')}
      </div>
      <div class="atlas-portfolio-signals">
        ${signals.map(([label, present]) => `
          <span class="${present === true ? 'is-present' : 'is-absent'}">${atlasPortfolioRenderEscape(label)}: ${present === true ? 'Present' : 'Absent'}</span>
        `).join('')}
      </div>
      ${languages.length ? `
        <div class="atlas-portfolio-languages">
          ${languages.map((row) => `<span>${atlasPortfolioRenderEscape(row?.language)} ${this.number(row?.files)}</span>`).join('')}
        </div>
      ` : ''}
      ${examples.length ? `
        <div class="atlas-portfolio-examples">
          <h5>Representative paths</h5>
          <ul>${examples.map((example) => this.renderExampleHtml(example)).join('')}</ul>
        </div>
      ` : ''}
    `;
  }

  renderExampleHtml(example) {
    const details = [
      atlasPortfolioRenderText(example?.kind),
      `${this.number(example?.recentCommitTouches)} sampled touches`
    ];
    if (example?.nonBlankLines !== null && example?.nonBlankLines !== undefined) {
      details.push(`${this.number(example.nonBlankLines)} nonblank lines`);
    }
    if (example?.curated?.topic) {
      const quality = example.curated.quality === null || example.curated.quality === undefined
        ? ''
        : ` ${this.number(example.curated.quality)}/5`;
      details.push(`curated ${atlasPortfolioRenderText(example.curated.topic)}${quality}`);
    }
    return `
      <li>
        <code>${atlasPortfolioRenderEscape(example?.path)}</code>
        <span>${atlasPortfolioRenderEscape(details.filter(Boolean).join(' | '))}</span>
      </li>
    `;
  }
}

window.AtlasPortfolioRenderer = AtlasPortfolioRenderer;
