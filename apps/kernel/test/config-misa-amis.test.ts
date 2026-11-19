// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS setting of the deployment (#3854, S2): one optional secret, the integrator's ClientID (it also signs AMIS's callbacks). Unset, the connector is off. A value that is not in the
// shape of a ClientID stops the start, and the error names the setting, never the value. The compose file and the example env know it by name, and the pilot check treats it as a secret.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const CLIENT = 'ae60ffcb-817e-474c-a4a3-212ca13a7984';

describe('MISA_AMIS_CLIENT_ID', () => {
  it('is optional: unset or empty, the connector is off', () => {
    expect(loadConfig({ ...BASE }).MISA_AMIS_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_AMIS_CLIENT_ID: '' }).MISA_AMIS_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_AMIS_CLIENT_ID: '   ' }).MISA_AMIS_CLIENT_ID).toBeUndefined();
  });

  it('takes a ClientID as MISA issues it, trimmed', () => {
    expect(loadConfig({ ...BASE, MISA_AMIS_CLIENT_ID: ` ${CLIENT} ` }).MISA_AMIS_CLIENT_ID).toBe(CLIENT);
  });

  it('refuses a value that cannot be a ClientID, naming the setting and never the value', () => {
    for (const bad of ['short', 'has a space in it', 'line\nbreak-in-it', 'x'.repeat(129), 'ключ-клиента-не-латиница']) {
      let message = '';
      try {
        loadConfig({ ...BASE, MISA_AMIS_CLIENT_ID: bad });
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message, JSON.stringify(bad)).toContain('MISA_AMIS_CLIENT_ID');
      expect(message).not.toContain(bad);
    }
  });

  it('is passed through by the compose file and documented, empty, in the example env', () => {
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    expect(compose).toContain('MISA_AMIS_CLIENT_ID: ${MISA_AMIS_CLIENT_ID:-}');
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    expect(example).toMatch(/^MISA_AMIS_CLIENT_ID=$/m);
  });
});

describe('MISA_AMIS_PUSH (#3902)', () => {
  it('is off unless it says on: unset or empty is undefined', () => {
    expect(loadConfig({ ...BASE }).MISA_AMIS_PUSH).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_AMIS_PUSH: '' }).MISA_AMIS_PUSH).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_AMIS_PUSH: 'on' }).MISA_AMIS_PUSH).toBe('on');
    expect(loadConfig({ ...BASE, MISA_AMIS_PUSH: 'off' }).MISA_AMIS_PUSH).toBe('off');
  });

  it('refuses a value that is neither, naming the setting', () => {
    expect(() => loadConfig({ ...BASE, MISA_AMIS_PUSH: 'yes' })).toThrow(/MISA_AMIS_PUSH/);
  });

  it('is passed through by the compose file and documented, empty, in the example env', () => {
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    expect(compose).toContain('MISA_AMIS_PUSH: ${MISA_AMIS_PUSH:-}');
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    expect(example).toMatch(/^MISA_AMIS_PUSH=$/m);
  });
});

describe('MISA_ASP_CLIENT_ID (#4111)', () => {
  it('is unset by default and when empty or blank: the ASP product is off', () => {
    expect(loadConfig({ ...BASE }).MISA_ASP_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_ASP_CLIENT_ID: '' }).MISA_ASP_CLIENT_ID).toBeUndefined();
    expect(loadConfig({ ...BASE, MISA_ASP_CLIENT_ID: '   ' }).MISA_ASP_CLIENT_ID).toBeUndefined();
  });

  it('is its own value, independent of the AMIS one, and trimmed', () => {
    expect(loadConfig({ ...BASE, MISA_ASP_CLIENT_ID: ` ${CLIENT} ` }).MISA_ASP_CLIENT_ID).toBe(CLIENT);
    const only = loadConfig({ ...BASE, MISA_ASP_CLIENT_ID: CLIENT });
    expect(only.MISA_AMIS_CLIENT_ID).toBeUndefined();
    expect(only.MISA_ASP_CLIENT_ID).toBe(CLIENT);
  });

  it('refuses a value that is not in the shape of a ClientID, naming the setting and never the value', () => {
    for (const bad of ['short', 'has space in it 12345', 'x'.repeat(129)]) {
      let message = '';
      try {
        loadConfig({ ...BASE, MISA_ASP_CLIENT_ID: bad });
      } catch (error) {
        message = String(error);
      }
      expect(message, JSON.stringify(bad)).toContain('MISA_ASP_CLIENT_ID');
      expect(message, JSON.stringify(bad)).not.toContain(bad);
    }
  });

  it('is passed through by the compose file and documented, empty, in the example env', () => {
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    expect(compose).toContain('MISA_ASP_CLIENT_ID: ${MISA_ASP_CLIENT_ID:-}');
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    expect(example).toMatch(/^MISA_ASP_CLIENT_ID=$/m);
  });
});
