// SPDX-License-Identifier: AGPL-3.0-only
// Meta's read of an object's state (issue #3301, plan docs/plan/ads-write.md section 4): `GET <object id>` with the fields `effective_status` and the review feedback (`ad_review_feedback` on an ad). It is a
// separate class from the writer and the activator, built with the same options and bound to the Graph API host the same way, and it only ever sends a GET: nothing here can
// change an object. The job never reaches it but through the frozen view of state-readers.ts.
//
// What Meta writes about a refusal is tainted text. The adapter keeps none of it: `ad_review_feedback` (on an ad) and `issues_info` (on a campaign, an ad set and an ad) become a
// short CODE of lower-case letters, digits and underscores (`issue_<error_code>`, or `feedback_<the reason's key>`), and a status Ludy waits on becomes `in_review` or
// `in_process`. The screen words the codes it knows in the reader's language and shows any other as plain text. [U] The exact shape of `ad_review_feedback` and `issues_info` is
// written from Meta's documentation; the live check (W2-5) records what Meta really sends.
import type { Fetch } from '@crove/channel';
import { Graph, GraphError, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import { graphHostOnly, metaAdsError } from './meta.ts';
import type { AdObjectStateSource, StateTarget } from './state-readers.ts';

const CALL_TIMEOUT_MS = 20_000;
const OBJECT_ID = /^\d{1,32}$/;
// Meta's answer for an object that does not exist (any more): code 100, subcode 33.
const NO_SUCH_OBJECT_SUBCODE = 33;

const FIELDS = {
  campaign: 'effective_status,issues_info',
  ad_set: 'effective_status,issues_info',
  ad: 'effective_status,issues_info,ad_review_feedback',
} as const;

export interface MetaAdStateReaderOptions {
  // The secret of the write app that issued the token.
  appSecret: string;
  graphVersion?: string;
  fetch?: Fetch;
  now?: () => Date;
}

// The token inside the sealed secret of a connection (`{ accessToken }`, as the connector seals it).
function tokenOf(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('unknown', 'BAD_SECRET');
  }
  const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || token === '') throw new AdPlatformError('unknown', 'BAD_SECRET');
  return token;
}

const slug = (text: string, max: number): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);

// `issues_info`: a list of `{ error_code, error_summary, ... }`. The first entry with a numeric code gives `issue_<code>`; its words are never kept.
function issueCode(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    const code = (issue as { error_code?: unknown } | null)?.error_code;
    if (typeof code === 'number' && Number.isInteger(code) && code > 0 && code < 1e12) return `issue_${code}`;
    if (typeof code === 'string' && /^\d{1,12}$/.test(code)) return `issue_${code}`;
  }
  return null;
}

// `ad_review_feedback`: `{ <placement>: { <reason key>: <explanation> } }`. The first reason key in sorted order gives `feedback_<key>`; the explanation is never kept.
function feedbackCode(feedback: unknown): string | null {
  if (feedback === null || typeof feedback !== 'object' || Array.isArray(feedback)) return null;
  const keys: string[] = [];
  for (const placement of Object.values(feedback as Record<string, unknown>)) {
    if (placement !== null && typeof placement === 'object' && !Array.isArray(placement)) keys.push(...Object.keys(placement as Record<string, unknown>));
  }
  for (const key of keys.sort()) {
    const code = slug(key, 51);
    if (code !== '') return `feedback_${code}`;
  }
  return null;
}

// The reason shown with a status: what the platform says was wrong, or that Ludy is waiting on a review. A refusal (`DISAPPROVED`) names its feedback first; any other status
// names the issue it carries first.
export function metaReasonOf(status: string, answer: { issues_info?: unknown; ad_review_feedback?: unknown }): string | null {
  const feedback = feedbackCode(answer.ad_review_feedback);
  const issue = issueCode(answer.issues_info);
  const found = status === 'DISAPPROVED' ? (feedback ?? issue) : (issue ?? feedback);
  if (found) return found;
  if (status === 'PENDING_REVIEW') return 'in_review';
  if (status === 'IN_PROCESS') return 'in_process';
  return null;
}

export class MetaAdStateReader implements AdObjectStateSource {
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdStateReaderOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  async readState(secret: string, object: StateTarget): Promise<{ status: string; reason: string | null } | null> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    const fields = FIELDS[object.level];
    if (!fields) throw new AdPlatformError('bad_request', 'LEVEL_NOT_READABLE');
    try {
      const answer = await this.graph.call<{ effective_status?: unknown; issues_info?: unknown; ad_review_feedback?: unknown }>('GET', object.id, { token, params: { fields }, timeoutMs: CALL_TIMEOUT_MS });
      if (typeof answer.effective_status !== 'string') throw new AdPlatformError('unknown', 'NO_STATUS');
      return { status: answer.effective_status, reason: metaReasonOf(answer.effective_status, answer) };
    } catch (error) {
      // An object Meta says it does not have (deleted, and past the time it still answers for it) is an answer, not a failure.
      if (error instanceof GraphError && error.code === 100 && error.subcode === NO_SUCH_OBJECT_SUBCODE) return null;
      throw metaAdsError(error, this.now);
    }
  }
}
