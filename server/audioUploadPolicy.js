const path = require('path');

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a'
]);

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.webm',
  '.wav',
  '.mp3',
  '.ogg',
  '.mp4',
  '.m4a'
]);

const normalizeAudioMimeType = (value) => String(value || '')
  .split(';', 1)[0]
  .trim()
  .toLowerCase();

const isSupportedAudioUpload = (file = {}) => {
  const mimeType = normalizeAudioMimeType(file.mimetype);
  if (SUPPORTED_AUDIO_MIME_TYPES.has(mimeType)) return true;

  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.has(extension);
};

module.exports = {
  isSupportedAudioUpload,
  normalizeAudioMimeType
};
