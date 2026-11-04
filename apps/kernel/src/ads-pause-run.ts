// SPDX-License-Identifier: AGPL-3.0-only
// The one platform step of the pause of a stopped launch (ADR-0043 points 4 and 7a, issue #2296, W2-4a), shared by the two places that make it: the pause job
// (ads-pause.ts, with the live write connection's token) and the revoke sweep (ads-revoke.ts, with the sealed copy of a closed connection's token, before it revokes).
// It hands the secret to the narrowed pauser and nothing else, and turns what the pauser answers into what `ads.pause.record` takes: ids, levels, the platform's kinds
// and codes. The secret never leaves this function, is never logged and never reaches a command.
import { PAUSE_LEVELS, type AdPauser, type PauseResult } from '@crove/ad-platform';
import type { PauseBegin, PauseResultInput } from '@crove/mod-ads';

export type PauseWork = Extract<PauseBegin, { action: 'pause' }>;

// The whole pause of a launch (up to three lists and a handful of status calls, each request limited to twenty seconds and aborted) may take this long before the run is
// given up on and the next one lists again.
const PAUSE_TIMEOUT_MS = 180_000;

const isPauseLevel = (level: string): level is 'campaign' | 'ad_set' | 'ad' => (PAUSE_LEVELS as readonly string[]).includes(level);

function report(out: PauseResult): PauseResultInput {
  const found = out.found.flatMap((o) => (isPauseLevel(o.level) && o.name.length > 0 ? [{ level: o.level, id: o.id, name: o.name.slice(0, 400) }] : []));
  return {
    kind: 'ran',
    listed: out.listed,
    found: found.slice(0, 300),
    paused: out.paused.slice(0, 300).map((p) => ({ level: p.level, id: p.id })),
    failed: out.failed.slice(0, 300).map((f) => ({ level: f.level, id: f.id, kind: f.kind, code: f.code })),
    notTried: Math.min(out.notTried, 300),
    tokenRefused: out.tokenRefused,
    retryAt: out.retryAt ? out.retryAt.toISOString() : null,
  };
}

export async function pauseWork(pauser: AdPauser, secret: string, work: PauseWork): Promise<PauseResultInput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      pauser.pauseLaunch(secret, work.account, { tag: work.tag, known: work.objects.map((o) => ({ level: o.level, id: o.externalId })) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PAUSE_TIMEOUT_MS);
      }),
    ]);
    return report(out);
  } catch (error) {
    // Never the error's own text (a message may carry a value): a class of failure only.
    return { kind: 'blocked', code: error instanceof Error && error.message === 'timeout' ? 'TIMEOUT' : 'ADAPTER_ERROR' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
