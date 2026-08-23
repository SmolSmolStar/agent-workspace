const { parseOwnerRepo, repositorySlug } = require('../../server/atlas/atlasIdentity');

describe('atlasIdentity GitHub remotes', () => {
  test.each([
    ['https://github.com/Owner/Repo.git', 'Owner/Repo'],
    ['ssh://git@github.com/Owner/Repo.git', 'Owner/Repo'],
    ['git@github.com:Owner/Repo.git', 'Owner/Repo'],
    ['github.com/Owner/Repo', 'Owner/Repo']
  ])('parses %s', (remoteUrl, expected) => {
    expect(parseOwnerRepo(remoteUrl)?.nameWithOwner).toBe(expected);
    expect(repositorySlug({ remoteUrl })).toBe(expected);
  });

  test.each([
    'https://evilgithub.com/owner/repo.git',
    'https://github.com.evil.test/owner/repo.git',
    'git@evilgithub.com:owner/repo.git',
    'https://github.com/owner/repo/extra',
    'file:///home/private/repo'
  ])('rejects non-GitHub or malformed remote %s', (remoteUrl) => {
    expect(parseOwnerRepo(remoteUrl)).toBeNull();
    expect(repositorySlug({ remoteUrl })).toBe('');
  });
});
