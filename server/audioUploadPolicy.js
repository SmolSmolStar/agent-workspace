const path = require('path');

const EXTENSIONS_BY_MIME_TYPE = new Map([
  ['audio/webm', new Set(['.webm'])],
  ['video/webm', new Set(['.webm'])],
  ['audio/wav', new Set(['.wav'])],
  ['audio/x-wav', new Set(['.wav'])],
  ['audio/mp3', new Set(['.mp3'])],
  ['audio/mpeg', new Set(['.mp3'])],
  ['audio/ogg', new Set(['.ogg'])],
  ['audio/mp4', new Set(['.mp4', '.m4a'])],
  ['video/mp4', new Set(['.mp4'])],
  ['audio/m4a', new Set(['.m4a'])],
  ['audio/x-m4a', new Set(['.m4a'])],
  ['audio/aac', new Set(['.aac'])]
]);
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream']);
const SUPPORTED_AUDIO_EXTENSIONS = new Set(
  Array.from(EXTENSIONS_BY_MIME_TYPE.values()).flatMap((extensions) => Array.from(extensions))
);

const normalizeAudioMimeType = (value) => String(value || '')
  .split(';', 1)[0]
  .trim()
  .toLowerCase();

const isSupportedAudioUpload = (file = {}) => {
  const mimeType = normalizeAudioMimeType(file.mimetype);
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  const expectedExtensions = EXTENSIONS_BY_MIME_TYPE.get(mimeType);
  if (expectedExtensions) return !extension || expectedExtensions.has(extension);
  return GENERIC_MIME_TYPES.has(mimeType) && SUPPORTED_AUDIO_EXTENSIONS.has(extension);
};

module.exports = {
  isSupportedAudioUpload,
  normalizeAudioMimeType
};
