// SPDX-License-Identifier: AGPL-3.0-only
// crove-media entry point (AI Meeting Notes M3, #2577).
// Media processing sandbox: ffmpeg, probe, normalize, split, repackage video.
// Runs with no credentials and an environment allowlist; in its image and anywhere
// NODE_ENV is not explicitly development or test, it refuses to start with unexpected variables.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { MEDIA_LIMITS, MEDIA_TIMING } from './types.ts';
import { createMediaApp } from './server.ts';

const schema = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(8095),
  HOST: z.string().default('127.0.0.1'),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(MEDIA_TIMING.concurrency),
  MEDIA_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(MEDIA_TIMING.maxQueue),
  MEDIA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(MEDIA_TIMING.processTimeoutMs),
  MEDIA_MAX_INPUT_BYTES: z.coerce.number().int().min(1024).max(MEDIA_LIMITS.maxVideoBytes).default(MEDIA_LIMITS.maxVideoBytes),
});

export type MediaConfig = z.infer<typeof schema>;

const CREDENTIAL_NAME =
  /SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|DATABASE_URL|_DSN$|^(AWS|GOOGLE|GCP|AZURE|S3|SUPABASE)_/i;

export const ALLOWED_VARIABLES: ReadonlySet<string> = new Set([
  ...Object.keys(schema.shape),
  'NODE_ENV',
  'NODE_VERSION',
  'YARN_VERSION',
  'PATH',
  'HOME',
  'HOSTNAME',
  'TERM',
  'container',
  'TMPDIR',
]);

export function credentialVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== '' && CREDENTIAL_NAME.test(name))
    .sort();
}

export function unexpectedVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && !ALLOWED_VARIABLES.has(name))
    .sort();
}

export const IMAGE_MARKER = '/etc/crove-media-image';

const RELAXED_NODE_ENV = new Set(['development', 'test']);

export function enforcesAllowlist(env: NodeJS.ProcessEnv, markerPath: string = IMAGE_MARKER): boolean {
  return existsSync(markerPath) || !RELAXED_NODE_ENV.has(env.NODE_ENV ?? '');
}

export interface LoadOptions {
  markerPath?: string;
}

export function loadMediaConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
  options: LoadOptions = {},
): MediaConfig {
  if (enforcesAllowlist(env, options.markerPath)) {
    const unexpected = unexpectedVariables(env);
    if (unexpected.length > 0) {
      throw new Error(`crove-media runs with its own settings only; remove ${unexpected.join(', ')} from its environment`);
    }
  } else {
    const credentials = credentialVariables(env);
    if (credentials.length > 0) {
      warn(
        `[media] crove-media must run without credentials; remove ${credentials.join(', ')} from its environment`,
      );
    }
  }

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

export function cleanupScratchDir(dir = process.env.TMPDIR || tmpdir()): void {
  try {
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('crove-media-')) {
          rmSync(join(dir, entry), { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    console.warn('[media] scratch cleanup warning:', err);
  }
}

export function startMediaServer(config: MediaConfig = loadMediaConfig()) {
  cleanupScratchDir();
  const app = createMediaApp({
    concurrency: config.MEDIA_CONCURRENCY,
    maxQueue: config.MEDIA_MAX_QUEUE,
    processTimeoutMs: config.MEDIA_TIMEOUT_MS,
    maxInputBytes: config.MEDIA_MAX_INPUT_BYTES,
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.HOST,
      port: config.PORT,
    },
    (info) => {
      console.log(`crove-media listening on http://${info.address}:${info.port}`);
    },
  );

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

// When executed directly, boot the service
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMediaServer();
}
