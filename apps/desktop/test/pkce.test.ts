// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildConnectUrl, deviceNameFor } from '../src/connect-url.ts';
import { newPkce } from '../src/pkce.ts';

describe('newPkce', () => {
  it('makes a 43-character verifier, its S256 challenge and a random state', () => {
    const a = newPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newPkce().verifier).not.toBe(a.verifier);
  });
});

describe('buildConnectUrl', () => {
  it('asks the app for a desktop sign-in with no scope', () => {
    const url = new URL(buildConnectUrl('https://ludy.example.vn', { challenge: 'c'.repeat(43), state: 'st', redirectUri: 'http://127.0.0.1:5555/ludy-desktop/callback', deviceName: 'Ludy Desktop, Windows, PC' }));
    expect(url.origin + url.pathname).toBe('https://ludy.example.vn/-/extension/connect');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: 'desktop',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      redirect_uri: 'http://127.0.0.1:5555/ludy-desktop/callback',
      state: 'st',
      device: 'Ludy Desktop, Windows, PC',
    });
    expect(url.searchParams.has('scope')).toBe(false);
  });
  it('names the device with a short, clean host name', () => {
    expect(deviceNameFor('DESKTOP-ABC123')).toBe('Ludy Desktop, Windows, DESKTOP-ABC123');
    expect(deviceNameFor('')).toBe('Ludy Desktop, Windows');
    expect(deviceNameFor('a'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(deviceNameFor('pc<script>\n')).toBe('Ludy Desktop, Windows, pcscript');
  });
});
