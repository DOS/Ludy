// SPDX-License-Identifier: AGPL-3.0-only

export type EnvPairSource = 'primary' | 'legacy' | 'both' | 'unset';

export type EnvPairResult =
  | { readonly ok: true; readonly value: string | undefined; readonly source: EnvPairSource }
  | { readonly ok: false; readonly error: string };

function normalizeEnvValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolves a primary (`LUDY_*`) and legacy (`CROVE_*`) environment variable pair.
 * Trims surrounding whitespace so blank values count as unset, and fails closed
 * without echoing variable values when both are non-empty and differ.
 */
export function checkEnvPair(
  env: Readonly<Record<string, string | undefined>>,
  primaryName: string,
  legacyName: string,
): EnvPairResult {
  const primary = normalizeEnvValue(env[primaryName]);
  const legacy = normalizeEnvValue(env[legacyName]);
  if (primary !== undefined && legacy !== undefined) {
    if (primary !== legacy) {
      return {
        ok: false,
        error: `${primaryName} and ${legacyName} are both set with conflicting values`,
      };
    }
    return { ok: true, value: primary, source: 'both' };
  }
  if (primary !== undefined) {
    return { ok: true, value: primary, source: 'primary' };
  }
  if (legacy !== undefined) {
    return { ok: true, value: legacy, source: 'legacy' };
  }
  return { ok: true, value: undefined, source: 'unset' };
}

/**
 * Reads a primary/legacy environment variable pair and throws when both are set
 * to different non-empty values.
 */
export function readEnvPair(
  env: Readonly<Record<string, string | undefined>>,
  primaryName: string,
  legacyName: string,
): string | undefined {
  const result = checkEnvPair(env, primaryName, legacyName);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}
