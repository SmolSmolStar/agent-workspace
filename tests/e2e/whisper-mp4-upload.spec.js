const { test, expect } = require('@playwright/test');

test('accepts an MP4 browser recording at the Whisper multipart boundary', async ({ request }) => {
  const statusResponse = await request.get('/api/whisper/status');
  expect(statusResponse.ok()).toBe(true);
  const whisperStatus = await statusResponse.json();

  const response = await request.post('/api/whisper/command', {
    multipart: {
      audio: {
        name: 'recording.mp4',
        mimeType: 'audio/mp4',
        buffer: Buffer.from('mp4-audio-fixture')
      }
    }
  });
  const contentType = response.headers()['content-type'] || '';

  expect(contentType).toContain('application/json');
  const body = await response.json();
  expect(body.error).not.toBe('Invalid audio format');
  if (whisperStatus.available === false) {
    expect(response.status()).toBe(503);
    expect(body.error).toBe('Whisper not available');
  } else {
    expect([200, 500]).toContain(response.status());
  }
});

test('rejects an explicit non-audio MIME even when the filename looks supported', async ({ request }) => {
  const response = await request.post('/api/whisper/command', {
    multipart: {
      audio: {
        name: 'recording.mp4',
        mimeType: 'image/png',
        buffer: Buffer.from('not-audio')
      }
    }
  });

  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toContain('application/json');
  await expect(response.json()).resolves.toEqual({ error: 'Invalid audio format' });
});
