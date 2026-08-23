const express = require('express');
const http = require('http');

const { EVIDENCE_QUEUE_FULL_CODE } = require('../../server/atlas/atlasEvidenceCoordinator');
const { createAtlasRoutes } = require('../../server/routes/atlasRoutes');

function getJson(server, requestPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

describe('atlasRoutes evidence endpoint', () => {
  let server;
  let evidenceAnalyzer;
  let logger;

  beforeEach((done) => {
    const app = express();
    evidenceAnalyzer = jest.fn().mockResolvedValue({ repoId: 'fixture', available: true, examples: [] });
    logger = { error: jest.fn() };
    app.use('/api/atlas', createAtlasRoutes({
      repoAtlasService: {
        getEntry: (id) => (id === 'fixture' ? { id, localPath: '/repos/fixture' } : null)
      },
      evidenceAnalyzer,
      logger
    }));
    server = app.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  test('returns live evidence for an atlas entry', async () => {
    const response = await getJson(server, '/api/atlas/entries/fixture/evidence?maxExamples=4');

    expect(response).toEqual({
      status: 200,
      body: { ok: true, evidence: { repoId: 'fixture', available: true, examples: [] } }
    });
    expect(evidenceAnalyzer).toHaveBeenCalledWith(
      { id: 'fixture', localPath: '/repos/fixture' },
      { maxExamples: '4' }
    );
  });

  test('returns 404 without running Git for an unknown entry', async () => {
    const response = await getJson(server, '/api/atlas/entries/missing/evidence');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, error: 'No atlas entry "missing"' });
    expect(evidenceAnalyzer).not.toHaveBeenCalled();
  });

  test('returns a generic server error when live Git inspection fails', async () => {
    evidenceAnalyzer.mockRejectedValueOnce(new Error('failed under /home/private/repository'));

    const response = await getJson(server, '/api/atlas/entries/fixture/evidence');

    expect(response).toEqual({
      status: 500,
      body: { ok: false, error: 'Repository evidence inspection failed.' }
    });
    expect(JSON.stringify(response.body)).not.toContain('/home/private/repository');
    expect(logger.error).toHaveBeenCalledWith(
      'Atlas: inspect repository evidence failed',
      expect.objectContaining({ error: 'failed under /home/private/repository' })
    );
  });

  test('returns a retryable status when the evidence queue is full', async () => {
    const error = new Error('Repository evidence queue is full.');
    error.code = EVIDENCE_QUEUE_FULL_CODE;
    evidenceAnalyzer.mockRejectedValueOnce(error);

    const response = await getJson(server, '/api/atlas/entries/fixture/evidence');

    expect(response).toEqual({
      status: 503,
      body: { ok: false, error: 'Repository evidence queue is busy. Retry later.' }
    });
  });
});
