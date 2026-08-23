const { BatchLaunchService } = require('../../server/batchLaunchService');

describe('BatchLaunchService admission control', () => {
  test('rejects a queued Codex card before allocating a worktree', async () => {
    const ensureWorkspaceMixedWorktree = jest.fn();
    const service = new BatchLaunchService({
      taskTicketingService: {},
      workspaceManager: {},
      sessionManager: {
        getAgentAdmissionDecision: jest.fn().mockReturnValue({
          allowed: false,
          code: 'codex-usage-draining',
          reason: 'window-rollover'
        })
      },
      taskRecordService: {},
      userSettingsService: {},
      ensureWorkspaceMixedWorktree,
      io: { emit: jest.fn() }
    });

    await expect(service._launchSingleCard({
      card: { id: 'card-1', name: 'Queued task' },
      provider: {},
      boardId: 'board-1',
      resolvedWorkspaceId: 'workspace-1',
      repoPath: '/tmp/repo',
      repoName: 'repo',
      repoType: 'website',
      defaultTier: 3,
      agentOverride: 'codex',
      customFieldDefs: [],
      globalPromptPrefix: '',
      boardPromptPrefix: '',
      moveToListId: null,
      worktreeId: 'work1'
    })).rejects.toMatchObject({
      phase: 'admission',
      code: 'codex-usage-draining'
    });

    expect(ensureWorkspaceMixedWorktree).not.toHaveBeenCalled();
  });
});
