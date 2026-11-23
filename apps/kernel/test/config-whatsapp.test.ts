// SPDX-License-Identifier: AGPL-3.0-only
// The WhatsApp Business settings of the deployment (conversation core, #3131): optional, the verify token needs the app secret, the previous secret is for a
// rotation only, the media hosts are domain names, and every one of them is a credential or a list the pilot check and the compose file know by name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, zaloMediaHostsOf } from '../src/config.ts';
import { checkEnv } from '../src/pilot-check.ts';
import { channelConversationAdapters, whatsappApp } from '../src/kernel.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const SECRET = { CHANNEL_WHATSAPP_APP_SECRET: 'whatsapp-app-secret-not-real' };

describe('the WhatsApp settings', () => {
  it('are all optional, and WhatsApp is offered with the app secret alone', () => {
    const none = loadConfig({ ...BASE });
    expect([none.CHANNEL_WHATSAPP_APP_SECRET, none.CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS, none.CHANNEL_WHATSAPP_VERIFY_TOKEN, none.CHANNEL_WHATSAPP_MEDIA_HOSTS]).toEqual([undefined, undefined, undefined, undefined]);
    expect(whatsappApp(none)).toBeNull();
    expect(channelConversationAdapters(none)).toEqual({});
    const set = loadConfig({ ...BASE, ...SECRET });
    expect(whatsappApp(set)).toEqual({ appSecret: 'whatsapp-app-secret-not-real', graphVersion: 'v24.0' });
    expect(Object.keys(channelConversationAdapters(set))).toEqual(['whatsapp']);
    expect(channelConversationAdapters(set).whatsapp?.provider).toBe('whatsapp');
  });

  it('take a verify token only beside the app secret, and a previous secret only for a rotation', () => {
    expect(loadConfig({ ...BASE, ...SECRET, CHANNEL_WHATSAPP_VERIFY_TOKEN: 'verify-token-not-real' }).CHANNEL_WHATSAPP_VERIFY_TOKEN).toBe('verify-token-not-real');
    expect(() => loadConfig({ ...BASE, CHANNEL_WHATSAPP_VERIFY_TOKEN: 'verify-token-not-real' })).toThrow(/needs CHANNEL_WHATSAPP_APP_SECRET/);
    expect(loadConfig({ ...BASE, ...SECRET, CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS: 'an-older-whatsapp-secret' }).CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS).toBe('an-older-whatsapp-secret');
    expect(() => loadConfig({ ...BASE, CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS: 'an-older-whatsapp-secret' })).toThrow(/without CHANNEL_WHATSAPP_APP_SECRET/);
    expect(() => loadConfig({ ...BASE, ...SECRET, CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS: 'short' })).toThrow(/CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS/);
    expect(() => loadConfig({ ...BASE, ...SECRET, CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS: SECRET.CHANNEL_WHATSAPP_APP_SECRET })).toThrow(/same as/);
    for (const bad of ['short', 'has a space in it', 'x'.repeat(201)]) {
      expect(() => loadConfig({ ...BASE, ...SECRET, CHANNEL_WHATSAPP_VERIFY_TOKEN: bad }), bad).toThrow(/CHANNEL_WHATSAPP_VERIFY_TOKEN/);
      expect(() => loadConfig({ ...BASE, CHANNEL_WHATSAPP_APP_SECRET: bad }), bad).toThrow(/CHANNEL_WHATSAPP_APP_SECRET/);
    }
  });

  it('take the media hosts as domain names, up to twenty', () => {
    const set = loadConfig({ ...BASE, CHANNEL_WHATSAPP_MEDIA_HOSTS: 'FBsbx.com, example.test ' });
    expect(zaloMediaHostsOf(set.CHANNEL_WHATSAPP_MEDIA_HOSTS)).toEqual(['fbsbx.com', 'example.test']);
    for (const bad of [',', 'localhost', '127.0.0.1', 'https://fbsbx.com', 'fbsbx.com/path', '*.fbsbx.com', Array.from({ length: 21 }, (_, i) => `h${i}.test`).join(',')]) {
      expect(() => loadConfig({ ...BASE, CHANNEL_WHATSAPP_MEDIA_HOSTS: bad }), bad).toThrow(/CHANNEL_WHATSAPP_MEDIA_HOSTS/);
    }
  });

  it('are secrets the pilot check refuses a sample of, and the compose file passes each through with an empty default', () => {
    const READY = { ...BASE };
    for (const name of ['CHANNEL_WHATSAPP_APP_SECRET', 'CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS', 'CHANNEL_WHATSAPP_VERIFY_TOKEN']) {
      const sample = checkEnv({ ...READY, [name]: 'change-me' } as Record<string, string>).filter((r) => r.status === 'fail').map((r) => r.message);
      expect(sample.join(' '), name).toContain(name);
    }
    expect(checkEnv({ ...READY, CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS: 'an-older-whatsapp-secret' } as Record<string, string>).some((r) => r.item === 'WhatsApp app secret rotation' && r.status === 'manual')).toBe(true);
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    for (const name of ['CHANNEL_WHATSAPP_APP_SECRET', 'CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS', 'CHANNEL_WHATSAPP_VERIFY_TOKEN', 'CHANNEL_WHATSAPP_MEDIA_HOSTS']) {
      expect(compose, name).toContain(`${name}: \${${name}:-}`);
    }
    // No value is committed with the names: the example file leaves each empty (or commented).
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    for (const name of ['CHANNEL_WHATSAPP_APP_SECRET', 'CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS', 'CHANNEL_WHATSAPP_VERIFY_TOKEN']) expect(example, name).toMatch(new RegExp(`^${name}=$`, 'm'));
  });
});
