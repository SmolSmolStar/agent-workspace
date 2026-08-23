const { test, expect } = require('@playwright/test');

test('accepts an MP4 browser recording at the Whisper multipart boundary', async ({ request }) => {
  const response = await request.post('/api/whisper/command', {
    multipart: {
      audio: {
        name: 'recording.mp4',
        mimeType: 'audio/mp4',
        buffer: Buffer.from('mp4-audio-fixture')
      }
    }
  });
  const body = await response.text();

  expect(response.status()).not.toBe(404);
  expect(body).not.toContain('Invalid audio format');
});
