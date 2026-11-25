// SPDX-License-Identifier: AGPL-3.0-only
// The recording player of a meeting's page (#4816): the four speeds, the speed remembered in the browser (and a storage that refuses is the same as none), setting the speed on the players that are there, and the
// jump to the start of a transcript line (a time that is no time moves nothing, and no player is ever started by it).
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE, PLAYBACK_RATES, applyRate, asRate, rateLabel, readStoredRate, seekPlayers, storeRate, type MediaLike } from '../src/lib/playback.ts';

const player = (over: Partial<MediaLike> = {}): MediaLike => ({ currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, ...over });
const store = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('the speeds', () => {
  it('are 1x, 1.25x, 1.5x and 2x, written as such', () => {
    expect([...PLAYBACK_RATES]).toEqual([1, 1.25, 1.5, 2]);
    expect(PLAYBACK_RATES.map(rateLabel)).toEqual(['1x', '1.25x', '1.5x', '2x']);
  });

  it('read a stored or typed value only when it is one of them', () => {
    expect(asRate('1.5')).toBe(1.5);
    expect(asRate(2)).toBe(2);
    for (const bad of ['', 'abc', '3', '0', '-1', '1.3', null, undefined, NaN, Infinity, {}]) expect(asRate(bad), String(bad)).toBeNull();
  });
});

describe('the speed kept in the browser', () => {
  it('is read back, and is 1x when nothing, something odd or nothing readable is stored', () => {
    const s = store();
    expect(readStoredRate(s)).toBe(DEFAULT_RATE);
    storeRate(1.5, s);
    expect(readStoredRate(s)).toBe(1.5);
    expect(readStoredRate(store({ 'ludy.meetings.playbackRate': '7' }))).toBe(1);
    expect(readStoredRate(null)).toBe(1);
    expect(readStoredRate({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined })).toBe(1);
  });

  it('is not kept when the storage refuses, with no error', () => {
    expect(() => storeRate(2, { getItem: () => null, setItem: () => { throw new Error('quota'); } })).not.toThrow();
    expect(() => storeRate(2, null)).not.toThrow();
  });
});

describe('applyRate', () => {
  it('sets the speed, and the one a new source starts at, on each player that is there', () => {
    const audio = player();
    const video = player();
    applyRate(1.25, [audio, null, video, undefined]);
    expect(audio).toMatchObject({ playbackRate: 1.25, defaultPlaybackRate: 1.25 });
    expect(video).toMatchObject({ playbackRate: 1.25, defaultPlaybackRate: 1.25 });
    applyRate(1, []);
  });
});

describe('seekPlayers', () => {
  it('moves each player that is there to the second, and says whether any moved', () => {
    const audio = player({ currentTime: 99 });
    const video = player();
    expect(seekPlayers([audio, null, video], 65.4)).toBe(true);
    expect(audio.currentTime).toBe(65.4);
    expect(video.currentTime).toBe(65.4);
    expect(seekPlayers([null, undefined], 10)).toBe(false);
    expect(seekPlayers([], 10)).toBe(false);
  });

  it('moves nothing for a time that is no time', () => {
    const audio = player({ currentTime: 7 });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(seekPlayers([audio], bad), String(bad)).toBe(false);
    expect(audio.currentTime).toBe(7);
    expect(seekPlayers([audio], 0)).toBe(true);
    expect(audio.currentTime).toBe(0);
  });
});
