// SPDX-License-Identifier: AGPL-3.0-only
// "Ghi cả video" is off by default; with it off no video is requested, recorded, stored or uploaded.
import { describe, expect, it } from 'vitest';
import { capturePlan } from '../src/capture-plan.ts';

const supports = () => true;

describe('capture plan', () => {
  it('with video off asks the tab for audio only and records, stores and uploads audio', () => {
    const plan = capturePlan({ streamId: 'abc', keepVideo: false, isTypeSupported: supports });
    expect(plan.tabConstraints.video).toBe(false);
    expect(plan.tabConstraints.audio.mandatory).toEqual({ chromeMediaSource: 'tab', chromeMediaSourceId: 'abc' });
    expect(plan.kind).toBe('audio');
    expect(plan.mimeType).toMatch(/^audio\//);
  });

  it('with video ticked asks the tab for its picture too and keeps a video recording', () => {
    const plan = capturePlan({ streamId: 'abc', keepVideo: true, isTypeSupported: supports });
    expect(plan.tabConstraints.video).toEqual({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'abc' } });
    expect(plan.kind).toBe('video');
    expect(plan.mimeType).toMatch(/^video\//);
  });

  it('never picks a video type for an audio recording, even when only video types are supported', () => {
    const plan = capturePlan({ streamId: 'x', keepVideo: false, isTypeSupported: (t) => t.startsWith('video/') });
    expect(plan.mimeType).toBeUndefined();
    expect(plan.kind).toBe('audio');
  });
});
