// SPDX-License-Identifier: AGPL-3.0-only
// What the launch job is given of an ad platform's writer (ADR-0043, issue #2296, W2-3): the calls of a launch and nothing else. Like the revoke worker's view
// (revokers.ts), it is a new, frozen object that calls the writer's methods through closures, so what the job holds cannot reach anything the list below does
// not name, not even by a cast: no `revokeToken`, and no `setStatus`, which is the pause and archive of W2-4 and the activation that W2-4 adds. The four
// creates leave every object PAUSED, so the launch job cannot spend: a launch ends W2-3 as objects created, paused. A test pins both the view and the source of
// this file.
import { activatorOf, type AdActivator } from './activators.ts';
import { MetaAdActivator } from './meta-activate.ts';
import { MetaAdManager } from './meta-manage.ts';
import { managerOf, type AdManager } from './managers.ts';
import { SandboxAdManager } from './sandbox-manage.ts';
import { META_WRITE_PROVIDER } from './meta-write-connector.ts';
import { MetaAdWriter } from './meta-write.ts';
import { MetaAdStateReader } from './meta-state.ts';
import { pauserOf, type AdPauser } from './pausers.ts';
import { SandboxAdActivator } from './sandbox-activate.ts';
import { SandboxAdStateReader } from './sandbox-state.ts';
import { sandboxAdWriter, type SandboxAdWriter } from './sandbox-write.ts';
import { stateReaderOf, type AdStateReader } from './state-readers.ts';
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

// The pausers of a deployment (W2-4a), by the provider id of the write connection they work with: the narrowed view the pause job is given of the same writers
// (pausers.ts): it finds the objects that carry a launch's tag and sets them PAUSED, and nothing else. A provider without a writer has none. The map is frozen too.
export function adPausers(options: LaunchWritersOptions): Readonly<Record<string, AdPauser>> {
  const pausers: Record<string, AdPauser> = {};
  if (options.sandbox) {
    const sandbox = options.sandbox === true ? sandboxAdWriter : options.sandbox;
    pausers[sandbox.provider] = pauserOf(sandbox);
  }
  if (options.meta) {
    const graphVersion = options.meta.graphVersion;
    const meta = new MetaAdWriter({ appSecret: options.meta.writeAppSecret, ...(graphVersion ? { graphVersion } : {}) });
    pausers[meta.provider] = pauserOf(meta);
  }
  return Object.freeze(pausers);
}

// The activators of a deployment (W2-4b), by the provider id of the write connection they work with: the frozen view the activation job is given (activators.ts), apart
// from the writers above, so the view that creates cannot switch anything on. Meta's is built with the same switch as its writer (ADS_LIVE_LAUNCH), with the secret of the
// same write app. A provider without one has no entry: its launches stay paused until a deployment that has one runs them. The map is frozen too.
export function adActivators(options: LaunchWritersOptions): Readonly<Record<string, AdActivator>> {
  const activators: Record<string, AdActivator> = {};
  if (options.sandbox) {
    const sandbox = options.sandbox === true ? sandboxAdWriter : options.sandbox;
    activators[sandbox.provider] = activatorOf(new SandboxAdActivator(sandbox));
  }
  if (options.meta) {
    const graphVersion = options.meta.graphVersion;
    activators[META_WRITE_PROVIDER] = activatorOf(new MetaAdActivator({ appSecret: options.meta.writeAppSecret, ...(graphVersion ? { graphVersion } : {}) }));
  }
  return Object.freeze(activators);
}

// The state readers of a deployment (#3301), by the provider id of the write connection they work with: the frozen view the state job is given (state-readers.ts), which reads
// what the platform says of the objects of a launch and nothing else. Built with the same switches as the writer (the sandbox; Meta's only where ADS_LIVE_LAUNCH is on, with the
// secret of the same write app). A provider without one has no entry: its objects keep the last state they had. The map is frozen too.
export function adStateReaders(options: LaunchWritersOptions): Readonly<Record<string, AdStateReader>> {
  const readers: Record<string, AdStateReader> = {};
  if (options.sandbox) {
    const sandbox = options.sandbox === true ? sandboxAdWriter : options.sandbox;
    readers[sandbox.provider] = stateReaderOf(new SandboxAdStateReader(sandbox));
  }
  if (options.meta) {
    const graphVersion = options.meta.graphVersion;
    readers[META_WRITE_PROVIDER] = stateReaderOf(new MetaAdStateReader({ appSecret: options.meta.writeAppSecret, ...(graphVersion ? { graphVersion } : {}) }));
  }
  return Object.freeze(readers);
}

// The managers of a deployment (#3835, W4), by the provider id of the write connection they work with: the frozen view the manage job is given (managers.ts), which changes a live
// launch's objects (a status, the ad set's budget and end time) and reads them back, and nothing else. Built with the same switches as the writer (the sandbox; Meta's only where
// ADS_LIVE_LAUNCH is on, with the secret of the same write app). The status changes go through the writer (pause, archive) and the activator (switch on) the deployment already
// has, which are built here and handed in, so the file that sends the switch-on stays the activation's. A provider without one has no entry: its changes stay queued. The map is
// frozen too.
export function adManagers(options: LaunchWritersOptions): Readonly<Record<string, AdManager>> {
  const managers: Record<string, AdManager> = {};
  if (options.sandbox) {
    const sandbox = options.sandbox === true ? sandboxAdWriter : options.sandbox;
    managers[sandbox.provider] = managerOf(new SandboxAdManager(sandbox, new SandboxAdActivator(sandbox)));
  }
  if (options.meta) {
    const graphVersion = options.meta.graphVersion;
    const versioned = graphVersion ? { graphVersion } : {};
    const writer = new MetaAdWriter({ appSecret: options.meta.writeAppSecret, ...versioned });
    const activator = new MetaAdActivator({ appSecret: options.meta.writeAppSecret, ...versioned });
    managers[META_WRITE_PROVIDER] = managerOf(new MetaAdManager({ appSecret: options.meta.writeAppSecret, writer, activator, ...versioned }));
  }
  return Object.freeze(managers);
}
