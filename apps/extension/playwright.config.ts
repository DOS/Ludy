// SPDX-License-Identifier: AGPL-3.0-only
// Loads the built, unpacked extension in Chromium against a fake Ludy server (e2e/fake-ludy.ts), with fake media devices.
// `pnpm --filter @crove/extension build` first; CI does it in the `extension` job. No docker stack is needed.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
