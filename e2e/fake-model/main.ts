// SPDX-License-Identifier: AGPL-3.0-only
// The fake model as a service for the AI end-to-end stack (compose.ai.yml): PORT (default 30001), HOST (default 0.0.0.0). Run with `node main.ts`.
import { startFakeModel } from './server.ts';

const model = await startFakeModel({ port: Number(process.env.PORT ?? 30001), host: process.env.HOST ?? '0.0.0.0' });
console.log(`fake model listening at ${model.url}`);
