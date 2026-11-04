// SPDX-License-Identifier: AGPL-3.0-only
// What the launch job is given of an ad platform's writer (ADR-0043, issue #2296, W2-3): the calls of a launch and nothing else. Like the revoke worker's view
// (revokers.ts), it is a new, frozen object that calls the writer's methods through closures, so what the job holds cannot reach anything the list below does
// not name, not even by a cast: no `revokeToken`, and no `setStatus`, which is the pause and archive of W2-4 and the activation that W2-4 adds. The four
// creates leave every object PAUSED, so the launch job cannot spend: a launch ends W2-3 as objects created, paused. A test pins both the view and the source of
// this file.
import { MetaAdWriter } from './meta-write.ts';
import { sandboxAdWriter, type SandboxAdWriter } from './sandbox-write.ts';
import type { AdWriter } from './writer.ts';

export type LaunchWriter = Pick<AdWriter, 'capabilities' | 'verify' | 'resolveTargeting' | 'createCampaign' | 'createAdSet' | 'createCreative' | 'createAd' | 'findByTag'>;

export function launchWriterOf(writer: LaunchWriter): LaunchWriter {
  return Object.freeze({
    capabilities: writer.capabilities,
    verify: (secret, account) => writer.verify(secret, account),
    resolveTargeting: (secret, query) => writer.resolveTargeting(secret, query),
    createCampaign: (secret, account, input) => writer.createCampaign(secret, account, input),
    createAdSet: (secret, account, input) => writer.createAdSet(secret, account, input),
    createCreative: (secret, account, input) => writer.createCreative(secret, account, input),
    createAd: (secret, account, input) => writer.createAd(secret, account, input),
    findByTag: (secret, account, level, tag) => writer.findByTag(secret, account, level, tag),
  });
}

export interface LaunchWritersOptions {
  // The offline sandbox's writer: `true` for the one of the process, or an instance (the tests' own, with its faults).
  sandbox?: boolean | SandboxAdWriter;
  // Meta's: only a deployment that was told to launch live has it (ADS_LIVE_LAUNCH), with the secret of the write app that issued the token.
  meta?: { writeAppSecret: string; graphVersion?: string };
}

// The launch writers of a deployment, by the provider id of the write connection they work with. A provider without one has no entry: its launches stay queued,
// untouched, until a deployment that has one runs them. The map is frozen too.
export function adLaunchWriters(options: LaunchWritersOptions): Readonly<Record<string, LaunchWriter>> {
  const writers: Record<string, LaunchWriter> = {};
  if (options.sandbox) {
    const sandbox = options.sandbox === true ? sandboxAdWriter : options.sandbox;
    writers[sandbox.provider] = launchWriterOf(sandbox);
  }
  if (options.meta) {
    const graphVersion = options.meta.graphVersion;
    const meta = new MetaAdWriter({ appSecret: options.meta.writeAppSecret, ...(graphVersion ? { graphVersion } : {}) });
    writers[meta.provider] = launchWriterOf(meta);
  }
  return Object.freeze(writers);
}
