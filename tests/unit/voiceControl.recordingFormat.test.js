const fs = require('fs');
const path = require('path');
const vm = require('vm');

const loadVoiceControlClass = ({ fetchImpl, BlobImpl, FormDataImpl, MediaRecorderImpl } = {}) => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'voice-control.js'), 'utf8');
  const sandbox = {
    window: {},
    console,
    fetch: fetchImpl,
    Blob: BlobImpl,
    FormData: FormDataImpl,
    MediaRecorder: MediaRecorderImpl,
    setTimeout: () => 0
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.VoiceControl;
};

describe('VoiceControl Whisper recording format', () => {
  test('selects MP4 when WebM recording is unavailable', () => {
    const VoiceControl = loadVoiceControlClass({
      MediaRecorderImpl: {
        isTypeSupported: (mimeType) => mimeType === 'audio/mp4'
      }
    });
    const control = Object.create(VoiceControl.prototype);

    expect(control.getSupportedRecordingMimeType()).toBe('audio/mp4');
  });

  test('keeps WebM upload behavior unchanged', () => {
    const VoiceControl = loadVoiceControlClass();
    const control = Object.create(VoiceControl.prototype);
    control.mediaRecorder = { mimeType: 'audio/webm' };

    expect(control.getRecordingUploadFormat()).toEqual({
      mimeType: 'audio/webm',
      extension: 'webm'
    });
  });

  test('uploads MP4 recorder output as MP4', async () => {
    let request;

    class FakeBlob {
      constructor(chunks, options) {
        this.chunks = chunks;
        this.type = options.type;
      }
    }

    class FakeFormData {
      constructor() {
        this.values = [];
      }

      append(name, value, filename) {
        this.values.push({ name, value, filename });
      }
    }

    const VoiceControl = loadVoiceControlClass({
      BlobImpl: FakeBlob,
      FormDataImpl: FakeFormData,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          json: async () => ({ success: true, command: 'open-queue', transcript: 'open queue', transcriptionTime: 12 })
        };
      }
    });

    const control = Object.create(VoiceControl.prototype);
    control.audioChunks = ['mp4-bytes'];
    control.mediaRecorder = { mimeType: 'audio/mp4' };
    control.button = { classList: { remove: jest.fn() } };
    control.transcriptEl = { textContent: '' };
    control.setStatus = jest.fn();
    control.showFeedback = jest.fn();

    await control.processWhisperRecording();

    const audio = request.options.body.values.find((value) => value.name === 'audio');
    expect(request.url).toBe('/api/whisper/command');
    expect(audio.value.type).toBe('audio/mp4');
    expect(audio.filename).toBe('recording.mp4');
  });
});
