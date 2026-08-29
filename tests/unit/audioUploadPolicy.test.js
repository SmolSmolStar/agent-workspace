const { isSupportedAudioUpload, normalizeAudioMimeType } = require('../../server/audioUploadPolicy');

describe('audioUploadPolicy', () => {
  test('accepts browser MP4 and M4A recordings', () => {
    expect(isSupportedAudioUpload({ mimetype: 'audio/mp4', originalname: 'recording.mp4' })).toBe(true);
    expect(isSupportedAudioUpload({ mimetype: 'audio/mp4; codecs=mp4a.40.2', originalname: 'recording.mp4' })).toBe(true);
    expect(isSupportedAudioUpload({ mimetype: 'audio/x-m4a', originalname: 'recording.m4a' })).toBe(true);
    expect(isSupportedAudioUpload({ mimetype: 'video/mp4', originalname: 'recording.mp4' })).toBe(true);
    expect(isSupportedAudioUpload({ mimetype: 'audio/aac', originalname: 'recording.aac' })).toBe(true);
  });

  test('keeps existing audio formats and extension fallback', () => {
    expect(isSupportedAudioUpload({ mimetype: 'audio/webm', originalname: 'recording.webm' })).toBe(true);
    expect(isSupportedAudioUpload({ mimetype: 'application/octet-stream', originalname: 'recording.ogg' })).toBe(true);
  });

  test('rejects unsupported uploads', () => {
    expect(isSupportedAudioUpload({ mimetype: 'image/png', originalname: 'recording.png' })).toBe(false);
    expect(isSupportedAudioUpload({ mimetype: 'application/octet-stream', originalname: 'recording.bin' })).toBe(false);
    expect(isSupportedAudioUpload({ mimetype: 'image/png', originalname: 'recording.mp4' })).toBe(false);
    expect(isSupportedAudioUpload({ mimetype: 'audio/mp4', originalname: 'recording.webm' })).toBe(false);
  });

  test('normalizes codec-qualified MIME types', () => {
    expect(normalizeAudioMimeType(' Audio/MP4; codecs=mp4a.40.2 ')).toBe('audio/mp4');
  });
});
