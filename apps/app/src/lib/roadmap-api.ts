// SPDX-License-Identifier: AGPL-3.0-only
// Public Roadmap HTTP API client + hash/storage helpers (#4399, ADR-0057).
import {
  ROADMAP_VOTER_HEADER,
  type RoadmapPublicOtpRequestResult,
  type RoadmapPublicOtpVerifyResult,
  type RoadmapPublicSubmitIdeaInput,
  type RoadmapPublicSubmitIdeaResult,
  type RoadmapPublicViewResult,
  type RoadmapPublicVoteResult,
} from '@ludy/kernel-contract';
import { apiUrl } from './api-base.ts';
import { accessToken } from './auth.ts';

export class PublicRoadmapError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'PublicRoadmapError';
    this.code = code;
    this.status = status;
  }
}

const memoryVoterTokens = new Map<string, string>();
const VOTER_STORAGE_PREFIX = 'ludy.roadmap.voter.v1:';
const UNSUB_HASH_PREFIX = 'unsubscribe=';

function voterStorageKey(orgSlug: string, boardSlug: string): string {
  return `${VOTER_STORAGE_PREFIX}${orgSlug.trim().toLowerCase()}:${boardSlug.trim().toLowerCase()}`;
}

export function loadRoadmapVoterToken(orgSlug: string, boardSlug: string): string | null {
  const key = voterStorageKey(orgSlug, boardSlug);
  const mem = memoryVoterTokens.get(key);
  if (mem) return mem;
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (stored) {
      memoryVoterTokens.set(key, stored);
      return stored;
    }
  } catch {
    // Ignore storage restriction inside strict third-party iframes.
  }
  return null;
}

export function rememberRoadmapVoterToken(orgSlug: string, boardSlug: string, token: string): void {
  const key = voterStorageKey(orgSlug, boardSlug);
  memoryVoterTokens.set(key, token);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, token);
  } catch {
    // Ignore storage restriction inside third-party iframes; in-memory token remains active.
  }
}

export function forgetRoadmapVoterToken(orgSlug: string, boardSlug: string): void {
  const key = voterStorageKey(orgSlug, boardSlug);
  memoryVoterTokens.delete(key);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage restriction.
  }
}

export function readRoadmapUnsubscribeTokenFromHash(hash?: string): string | null {
  const raw = hash ?? (typeof window !== 'undefined' ? window.location.hash : '');
  if (!raw || raw.length < 2) return null;
  const clean = raw.startsWith('#') ? raw.slice(1) : raw;
  for (const part of clean.split('&')) {
    if (part.startsWith(UNSUB_HASH_PREFIX)) {
      const value = decodeURIComponent(part.slice(UNSUB_HASH_PREFIX.length)).trim();
      if (/^[A-Za-z0-9._~-]{16,256}$/.test(value)) return value;
    }
  }
  return null;
}

export function scrubRoadmapUrlHash(): void {
  if (typeof window === 'undefined') return;
  if (!window.location.hash) return;
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    // Ignore restricted history API calls.
  }
}

function buildPublicHeaders(orgSlug: string, boardSlug: string, withJsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (withJsonBody) headers['content-type'] = 'application/json';
  const voterToken = loadRoadmapVoterToken(orgSlug, boardSlug);
  if (voterToken) {
    headers[ROADMAP_VOTER_HEADER] = voterToken;
  }
  const bearer = accessToken();
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  return headers;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    | (T & { code?: string; message?: string })
    | null;
  if (!response.ok) {
    const code = data?.code ?? `HTTP_${response.status}`;
    const message = data?.message ?? response.statusText ?? 'Request failed';
    throw new PublicRoadmapError(code, response.status, message);
  }
  if (!data) {
    throw new PublicRoadmapError('EMPTY_RESPONSE', response.status, 'Empty response');
  }
  return data;
}

function endpointBase(orgSlug: string, boardSlug: string): string {
  return apiUrl(`/api/projects/public-roadmap/${encodeURIComponent(orgSlug)}/${encodeURIComponent(boardSlug)}`);
}

export const publicRoadmapApi = {
  async view(orgSlug: string, boardSlug: string): Promise<RoadmapPublicViewResult> {
    const res = await fetch(endpointBase(orgSlug, boardSlug), {
      method: 'GET',
      headers: buildPublicHeaders(orgSlug, boardSlug, false),
    });
    return parseJsonOrThrow<RoadmapPublicViewResult>(res);
  },

  async requestOtp(orgSlug: string, boardSlug: string, email: string): Promise<RoadmapPublicOtpRequestResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return parseJsonOrThrow<RoadmapPublicOtpRequestResult>(res);
  },

  async verifyOtp(
    orgSlug: string,
    boardSlug: string,
    input: { email: string; code: string; notifyOnShip?: boolean },
  ): Promise<RoadmapPublicOtpVerifyResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => null)) as RoadmapPublicOtpVerifyResult & { code?: string; message?: string } | null;
    if (res.status === 200 && data?.ok) {
      if (data.voterToken) {
        rememberRoadmapVoterToken(orgSlug, boardSlug, data.voterToken);
      }
      return data;
    }
    if ((res.status === 401 || res.status === 423) && data && typeof data.ok === 'boolean') {
      return data;
    }
    throw new PublicRoadmapError(data?.code ?? `HTTP_${res.status}`, res.status, data?.message ?? 'Verification failed');
  },

  async submitIdea(
    orgSlug: string,
    boardSlug: string,
    input: RoadmapPublicSubmitIdeaInput,
  ): Promise<RoadmapPublicSubmitIdeaResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/ideas`, {
      method: 'POST',
      headers: buildPublicHeaders(orgSlug, boardSlug, true),
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<RoadmapPublicSubmitIdeaResult>(res);
  },

  async vote(
    orgSlug: string,
    boardSlug: string,
    input: { itemId: string; action?: 'vote' | 'unvote' | 'toggle'; notifyOnShip?: boolean },
  ): Promise<RoadmapPublicVoteResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/votes`, {
      method: 'POST',
      headers: buildPublicHeaders(orgSlug, boardSlug, true),
      body: JSON.stringify({
        itemId: input.itemId,
        action: input.action ?? 'toggle',
        ...(input.notifyOnShip !== undefined ? { notifyOnShip: input.notifyOnShip } : {}),
      }),
    });
    return parseJsonOrThrow<RoadmapPublicVoteResult>(res);
  },

  async unsubscribe(orgSlug: string, boardSlug: string, unsubscribeToken: string): Promise<RoadmapPublicVoteResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe', unsubscribeToken }),
    });
    return parseJsonOrThrow<RoadmapPublicVoteResult>(res);
  },

  async subscribe(orgSlug: string, boardSlug: string, notifyOnShip: boolean): Promise<RoadmapPublicVoteResult> {
    const res = await fetch(`${endpointBase(orgSlug, boardSlug)}/votes`, {
      method: 'POST',
      headers: buildPublicHeaders(orgSlug, boardSlug, true),
      body: JSON.stringify({ action: 'subscribe', notifyOnShip }),
    });
    return parseJsonOrThrow<RoadmapPublicVoteResult>(res);
  },
};
