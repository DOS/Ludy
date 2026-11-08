// SPDX-License-Identifier: AGPL-3.0-only
// Container smoke test for crove-media (AI Meeting Notes M3, #2577).
// Runs against the real container in CI and verifies all operations and acceptance criteria:
// 1. Probing, normalizing to mono Opus, splitting into 10-minute segments, extracting audio from video, repackaging video.
// 2. Acceptance criterion 1: A 2-hour file is normalized and split within the time limit.
// 3. Acceptance criterion 2: Malformed or hostile files fail cleanly with typed errors.
// Usage: node smoke.mjs [baseUrl]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base = 'http://crove-media:8095'] = process.argv.slice(2);

console.log(`Starting crove-media smoke test against ${base}...`);

// Verify healthz
const healthRes = await fetch(`${base}/healthz`);
if (!healthRes.ok) {
  console.error(`FAIL: /healthz returned status ${healthRes.status}`);
  process.exit(1);
}
console.log('crove-media /healthz is healthy');

// Generate test audio and video payloads using ffmpeg
function genMedia(args, outName) {
  const outPath = join(tmpdir(), outName);
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, outPath]);
  return readFileSync(outPath);
}

// 1. A 5-second sine wave audio file (WAV)
const audio5s = genMedia(
  ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=5', '-c:a', 'pcm_s16le'],
  'smoke-5s.wav',
);

// 1b. A 12-second sine wave audio file (WAV) for segment splitting
const audio12s = genMedia(
  ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=12', '-c:a', 'pcm_s16le'],
  'smoke-12s.wav',
);

// 2. A 5-second video with audio track
const video5s = genMedia(
  [
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
  ],
  'smoke-video5s.mp4',
);

// 3. A video without audio track
const videoNoAudio = genMedia(
  [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  ],
  'smoke-noaudio.mp4',
);

// 4. A 2-hour (7200s) audio file (anullsrc generates silent audio in ~1-2 seconds)
console.log('Generating 2-hour synthetic audio fixture...');
const audio2hr = genMedia(
  ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '7200', '-c:a', 'libopus', '-b:a', '24k'],
  'smoke-2hr.opus',
);
console.log(`Generated 2-hour audio fixture: ${audio2hr.byteLength} bytes`);

async function callEndpoint(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/octet-stream' },
  });
  return { status: res.status, json: await res.json() };
}

const failures = [];
function check(name, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`);
  if (!condition) {
    failures.push(`${name}: ${JSON.stringify(detail).slice(0, 500)}`);
  }
}

// Test 1: Probe audio
const p1 = await callEndpoint('/probe', audio5s);
check('probe audio5s returns correct metadata', p1.status === 200 && p1.json.ok && p1.json.result.hasAudio && !p1.json.result.hasVideo && p1.json.result.durationSeconds >= 4.9, p1);

// Test 2: Probe video
const p2 = await callEndpoint('/probe', video5s);
check('probe video5s detects both audio and video', p2.status === 200 && p2.json.ok && p2.json.result.hasAudio && p2.json.result.hasVideo && p2.json.result.durationSeconds >= 4.9, p2);

// Test 3: Normalize audio to mono Opus
const n1 = await callEndpoint('/normalize?bitrate_kbps=24', audio5s);
check('normalize audio5s produces mono Opus at 48kHz', n1.status === 200 && n1.json.ok && n1.json.result.format === 'opus' && n1.json.result.channels === 1 && n1.json.result.sampleRate === 48000 && n1.json.result.audioBase64.length > 0, n1);

// Test 4: Extract and normalize audio track from video
const n2 = await callEndpoint('/normalize', video5s);
check('normalize video5s extracts audio track to mono Opus', n2.status === 200 && n2.json.ok && n2.json.result.format === 'opus' && n2.json.result.channels === 1, n2);

// Test 5: Split audio into segments
const s1 = await callEndpoint('/split?max_segment_seconds=5', audio12s);
check('split audio12s with 5s segment length produces 3 segments', s1.status === 200 && s1.json.ok && s1.json.result.segmentCount === 3 && s1.json.result.segments.length === 3, s1);

// Test 6: Repackage video without audio (streaming binary output)
const r1Res = await fetch(`${base}/repackage-video?drop_audio=true`, {
  method: 'POST',
  body: video5s,
  headers: { 'content-type': 'application/octet-stream' },
});
const r1Bytes = await r1Res.arrayBuffer();
check('repackage-video drops audio track and returns binary stream', r1Res.status === 200 && r1Bytes.byteLength > 1000, { status: r1Res.status, length: r1Bytes.byteLength });

// Test 7: All-in-one process endpoint
const proc1 = await callEndpoint('/process?max_segment_seconds=5', video5s);
check('process endpoint returns probe, normalized audio, and segments', proc1.status === 200 && proc1.json.ok && proc1.json.result.probe.hasVideo && proc1.json.result.segments.length > 0 && proc1.json.result.normalizedAudioBase64.length > 0, proc1);

// Acceptance Criterion 1: A 2-hour file is normalized and split within the time limit
console.log('Testing Acceptance Criterion 1: 2-hour audio file normalization and splitting...');
const t0 = Date.now();
const split2hr = await callEndpoint('/split?max_segment_seconds=600', audio2hr);
const elapsedMs = Date.now() - t0;
console.log(`2-hour audio file split into ${split2hr.json.result?.segmentCount} segments in ${elapsedMs}ms`);
check(
  'Acceptance Criterion 1: 2-hour file normalized and split into 10-minute segments within time limit (<60s)',
  split2hr.status === 200 &&
    split2hr.json.ok &&
    split2hr.json.result.segmentCount >= 12 &&
    split2hr.json.result.segmentCount <= 13 &&
    split2hr.json.result.durationSeconds >= 7190 &&
    elapsedMs < 60_000,
  { status: split2hr.status, segmentCount: split2hr.json.result?.segmentCount, elapsedMs },
);

// Acceptance Criterion 2: Malformed or hostile files fail cleanly
console.log('Testing Acceptance Criterion 2: Malformed or hostile files fail cleanly...');
const malformedBytes = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt not valid audio at all random garbage bytes');
const bad1 = await callEndpoint('/probe', malformedBytes);
check('malformed media fails with typed 422 malformed_media error', bad1.status === 422 && bad1.json.ok === false && bad1.json.code === 'malformed_media', bad1);

const bad2 = await callEndpoint('/normalize', videoNoAudio);
check('video without audio track fails with typed 422 no_audio_stream error', bad2.status === 422 && bad2.json.ok === false && bad2.json.code === 'no_audio_stream', bad2);

const bad3 = await callEndpoint('/probe', Buffer.alloc(0));
check('empty payload fails with typed 400 bad_request error', bad3.status === 400 && bad3.json.ok === false && bad3.json.code === 'bad_request', bad3);

// Hostile protocol / demuxer test: ffconcat with local file reference
const concatHostile = Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n');
const badConcat = await callEndpoint('/probe', concatHostile);
check(
  'hostile ffconcat payload fails with typed 422 malformed_media without leaking paths or contents',
  badConcat.status === 422 &&
    badConcat.json.ok === false &&
    badConcat.json.code === 'malformed_media' &&
    !JSON.stringify(badConcat.json).includes('/etc/passwd') &&
    !JSON.stringify(badConcat.json).includes('root:'),
  badConcat,
);

// AI Meeting Notes M7 (#2581): what each browser's MediaRecorder writes normalizes in the real container, and a recording cut off
// mid-write (the recovered one) still yields the part that was saved. The files are synthesized in the shapes those recorders write.
const FRAG = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'];
const audioSrc = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12'];
const videoSrc = ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=duration=6'];
const browserFiles = {
  'Chrome/Edge/Firefox audio webm-opus': genMedia([...audioSrc, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm'], 'rec-audio.webm'),
  'Firefox audio ogg-opus': genMedia([...audioSrc, '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'], 'rec-audio.ogg'),
  'Safari audio mp4-aac (fragmented)': genMedia([...audioSrc, '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', ...FRAG], 'rec-audio.mp4'),
  'Chrome/Edge/Firefox video webm-vp8-opus': genMedia([...videoSrc, '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-f', 'webm'], 'rec-video.webm'),
  'Safari video mp4-h264-aac (fragmented)': genMedia([...videoSrc, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', ...FRAG], 'rec-video.mp4'),
};
for (const [name, bytes] of Object.entries(browserFiles)) {
  const res = await callEndpoint('/normalize', bytes);
  check(`browser recording normalizes to mono Opus: ${name}`, res.status === 200 && res.json.ok && res.json.result.format === 'opus' && res.json.result.channels === 1 && res.json.result.audioBase64.length > 0, res);
}
const cutWebm = browserFiles['Chrome/Edge/Firefox audio webm-opus'].subarray(0, Math.floor(browserFiles['Chrome/Edge/Firefox audio webm-opus'].byteLength * 0.6));
const cutRes = await callEndpoint('/normalize', cutWebm);
check('a webm cut off mid-recording still normalizes the saved part', cutRes.status === 200 && cutRes.json.ok && cutRes.json.result.format === 'opus', cutRes);

// Service remains responsive and healthy after all operations
const postHealth = await fetch(`${base}/healthz`);
check('service remains healthy after heavy 2hr and hostile inputs', postHealth.ok, postHealth.status);

if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} smoke checks:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('\nALL crove-media smoke checks passed successfully!');
