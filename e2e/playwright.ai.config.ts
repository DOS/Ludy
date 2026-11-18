// SPDX-License-Identifier: AGPL-3.0-only
// The Playwright config of the AI end-to-end job (#3805): the same settings as playwright.config.ts, on the specs in tests-ai/, against a stack with a fake model (compose.ai.yml). The default job
// never runs these (its shards list the files of tests/), and this job never runs those.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({ ...base, testDir: './tests-ai' });
