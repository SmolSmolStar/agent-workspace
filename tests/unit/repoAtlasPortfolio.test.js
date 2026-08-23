const {
  createPortfolioReport,
  formatPortfolioReport
} = require('../../server/atlas/atlasPortfolio');

function evidenceFor(repoId) {
  return {
    repoId,
    available: true,
    checkout: { resolution: 'exact' },
    history: {
      commitCount: 12,
      authorIdentityCount: 2,
      firstCommitAt: null,
      lastCommitAt: null,
      tagCount: 1,
      latestTagByCreatorDate: 'v1.0.0',
      sampledCommitCount: 12
    },
    code: {
      trackedFiles: 8,
      sourceFiles: 5,
      testFiles: 2,
      testToSourceRatio: 0.4,
      languages: [{ language: 'JavaScript', files: 7 }]
    },
    practices: {
      ciConfigCount: 1,
      hasCodebaseDocumentation: true,
      hasAgentInstructions: true,
      hasDependencyLockfile: true,
      hasTests: true
    },
    examples: [{
      path: 'src/index.js',
      kind: 'frequently-changed-source',
      recentCommitTouches: 4,
      nonBlankLines: 20
    }]
  };
}

describe('atlas portfolio report', () => {
  test('keeps repository order while bounding concurrent evidence work', async () => {
    let active = 0;
    let peak = 0;
    const analyzeFn = jest.fn(async (entry) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, entry.id === 'first' ? 20 : 5));
      active -= 1;
      return evidenceFor(entry.id);
    });
    const entries = [
      { id: 'first', name: 'First', summary: 'First summary', cloned: true, localPath: '/private/first' },
      { id: 'remote', name: 'Remote', summary: 'Remote only', cloned: false },
      { id: 'second', name: 'Second', summary: 'Second summary', cloned: true, localPath: '/private/second' },
      { id: 'third', name: 'Third', summary: 'Third summary', cloned: true, localPath: '/private/third' }
    ];

    const report = await createPortfolioReport(entries, { limit: 3 }, { analyzeFn });

    expect(peak).toBe(2);
    expect(analyzeFn).toHaveBeenCalledTimes(3);
    expect(report).toMatchObject({
      eligibleCount: 3,
      repositoryCount: 3,
      omittedCount: 0
    });
    expect(report.repositories.map((row) => row.repository.id)).toEqual(['first', 'second', 'third']);
    expect(report.repositories[0].repository.summary).toBe('First summary');
    expect(report.repositories[0].repository.quality).toBeNull();
    expect(JSON.stringify(report)).not.toContain('/private/');
  });

  test('waits for sibling work before propagating an evidence failure', async () => {
    let siblingFinished = false;
    const analyzeFn = async (entry) => {
      if (entry.id === 'broken') throw new Error('inspection failed');
      await new Promise((resolve) => setTimeout(resolve, 25));
      siblingFinished = true;
      return evidenceFor(entry.id);
    };

    await expect(createPortfolioReport([
      { id: 'broken', cloned: true },
      { id: 'slow', cloned: true }
    ], {}, { analyzeFn })).rejects.toThrow('inspection failed');
    expect(siblingFinished).toBe(true);
  });

  test('can include remote entries and explains truncation in text', async () => {
    const report = await createPortfolioReport([
      { id: 'local', name: 'Local', summary: 'Measured locally', cloned: true },
      { id: 'remote', name: 'Remote', summary: 'No checkout', cloned: false }
    ], { includeRemote: true, limit: 1 }, {
      analyzeFn: async (entry) => evidenceFor(entry.id)
    });

    expect(report).toMatchObject({ eligibleCount: 2, repositoryCount: 1, omittedCount: 1 });
    expect(formatPortfolioReport(report)).toContain('1 of 2 matching repositories');
    expect(formatPortfolioReport(report)).toContain('Measured locally');
  });
});
