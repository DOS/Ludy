// SPDX-License-Identifier: AGPL-3.0-only
// TRANSCRIBE_BASE_URL (meetings transcription, #2863): the recording and the key travel to it, so it is https; plain http only for a provider on this machine.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

describe('TRANSCRIBE_BASE_URL', () => {
  it('is optional, and takes https', () => {
    expect(loadConfig({ ...BASE }).TRANSCRIBE_BASE_URL).toBeUndefined();
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: '' }).TRANSCRIBE_BASE_URL).toBeUndefined();
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'https://stt.example.com/v1' }).TRANSCRIBE_BASE_URL).toBe('https://stt.example.com/v1');
  });

  it('takes plain http only for localhost and 127.0.0.1 without the opt-in', () => {
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'http://localhost:8000/v1' }).TRANSCRIBE_BASE_URL).toBe('http://localhost:8000/v1');
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'http://127.0.0.1:8000/v1' }).TRANSCRIBE_BASE_URL).toBe('http://127.0.0.1:8000/v1');
    for (const url of ['http://whisper:8000/v1', 'http://stt.example.com/v1', 'http://10.0.0.5:8000/v1', 'http://localhost.evil.example/v1', 'http://user@stt.example.com/v1']) {
      expect(() => loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: url }), url).toThrow(/TRANSCRIBE_BASE_URL/);
      expect(() => loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: url, TRANSCRIBE_ALLOW_INSECURE_HTTP: '0' }), `${url} with the opt-in off`).toThrow(/TRANSCRIBE_BASE_URL/);
    }
  });

  it('takes plain http to any host with TRANSCRIBE_ALLOW_INSECURE_HTTP=1, and only the values 0 and 1', () => {
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'http://whisper:8000/v1', TRANSCRIBE_ALLOW_INSECURE_HTTP: '1' }).TRANSCRIBE_BASE_URL).toBe('http://whisper:8000/v1');
    expect(loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'https://stt.example.com/v1', TRANSCRIBE_ALLOW_INSECURE_HTTP: '1' }).TRANSCRIBE_BASE_URL).toBe('https://stt.example.com/v1');
    expect(loadConfig({ ...BASE }).TRANSCRIBE_ALLOW_INSECURE_HTTP).toBe('0');
    expect(() => loadConfig({ ...BASE, TRANSCRIBE_BASE_URL: 'http://whisper:8000/v1', TRANSCRIBE_ALLOW_INSECURE_HTTP: 'yes' })).toThrow(/TRANSCRIBE_ALLOW_INSECURE_HTTP/);
  });
});

// TRANSCRIBE_API_MODE (#2972): how a chunk is sent; the default is today's /audio/transcriptions.
describe('TRANSCRIBE_API_MODE', () => {
  it('defaults to audio_transcriptions and takes chat_input_audio', () => {
    expect(loadConfig({ ...BASE }).TRANSCRIBE_API_MODE).toBe('audio_transcriptions');
    expect(loadConfig({ ...BASE, TRANSCRIBE_API_MODE: '' }).TRANSCRIBE_API_MODE).toBe('audio_transcriptions');
    expect(loadConfig({ ...BASE, TRANSCRIBE_API_MODE: 'audio_transcriptions' }).TRANSCRIBE_API_MODE).toBe('audio_transcriptions');
    expect(loadConfig({ ...BASE, TRANSCRIBE_API_MODE: 'chat_input_audio' }).TRANSCRIBE_API_MODE).toBe('chat_input_audio');
  });

  it('refuses any other value, so a typo does not silently send to the wrong endpoint', () => {
    for (const mode of ['chat', 'audio', 'Chat_Input_Audio', 'whisper']) {
      expect(() => loadConfig({ ...BASE, TRANSCRIBE_API_MODE: mode }), mode).toThrow(/TRANSCRIBE_API_MODE/);
    }
  });
});

// MEETINGS_VIDEO_STREAMS_MAX (#2965): the process-wide cap of meeting videos streamed at once.
describe('MEETINGS_VIDEO_STREAMS_MAX', () => {
  it('defaults to 64 and takes a whole number from 1 to 4096', () => {
    expect(loadConfig({ ...BASE }).MEETINGS_VIDEO_STREAMS_MAX).toBe(64);
    expect(loadConfig({ ...BASE, MEETINGS_VIDEO_STREAMS_MAX: '' }).MEETINGS_VIDEO_STREAMS_MAX).toBe(64);
    expect(loadConfig({ ...BASE, MEETINGS_VIDEO_STREAMS_MAX: '200' }).MEETINGS_VIDEO_STREAMS_MAX).toBe(200);
    for (const bad of ['0', '-1', '4097', '1.5', 'many']) expect(() => loadConfig({ ...BASE, MEETINGS_VIDEO_STREAMS_MAX: bad }), bad).toThrow(/MEETINGS_VIDEO_STREAMS_MAX/);
  });
});
