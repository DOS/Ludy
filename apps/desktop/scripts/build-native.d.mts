// SPDX-License-Identifier: AGPL-3.0-only
// Type definitions for apps/desktop/scripts/build-native.mjs for TypeScript tests.
type ExistsFn = (path: string) => boolean;
type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
type MkdirFn = (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
type RmFn = (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;

export function assertSafeCmdPath(label: string, value: string): string;
export function findVsDevCmd(env?: NodeJS.ProcessEnv, exists?: ExistsFn, runSpawn?: SpawnFn): string | null;
export function formatClArgs(srcPath?: string, outExe?: string, objDir?: string): string;
export function buildCmdLine(clArgs: string, vcvars?: string | null): string;
export function isMainEntry(argv1: string | undefined, selfPath?: string, platform?: NodeJS.Platform): boolean;
export function buildNative(options?: {
  requireWin32?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: ExistsFn;
  runSpawn?: SpawnFn;
  mkdirImpl?: MkdirFn;
  rmImpl?: RmFn;
  srcPath?: string;
  outExe?: string;
  objDir?: string;
}): Promise<{ compiled: boolean; skipped: boolean; output: string | null }>;
