// SPDX-License-Identifier: AGPL-3.0-only
// What the extension keeps in its own storage (chrome.storage.local, visible to this extension only): the built-in Ludy
// App and API origins, one connected account per org (the extension token and the org's slug), and which features the
// member turned on. The token is the only secret; the kernel stores its hash. Tokens stay pinned to their origins so an
// upgraded or rebuilt package never sends tokens from another server to Ludy Cloud (or vice versa).
import { DEFAULT_API_ADDRESS, DEFAULT_APP_ADDRESS } from './ludy-address.ts';

export interface Account {
  orgId: string;
  orgSlug: string;
  token: string;
  expiresAt: string;
  tokenId?: string;
}

export interface State {
  appAddress: string;
  apiAddress: string;
  accounts: Record<string, Account>;
  activeOrg: string | null;
  enabled: Record<string, boolean>;
}

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const KEY = 'ludy-extension-state';

export const emptyState = (): State => ({
  appAddress: DEFAULT_APP_ADDRESS,
  apiAddress: DEFAULT_API_ADDRESS,
  accounts: {},
  activeOrg: null,
  enabled: {},
});

// Whatever storage holds is checked, not trusted: a damaged value reads as the empty state.
// Legacy `{ address: 'https://app.ludy.vn', accounts }` upgrades cleanly to split Cloud origins without dropping
// existing accounts; accounts stored for any other origin are dropped so tokens never leak across origins.
export function readState(raw: unknown): State {
  if (typeof raw !== 'object' || raw === null) return emptyState();
  const r = raw as Record<string, unknown>;
  const enabled: Record<string, boolean> = {};
  const rawEnabled = r.enabled;
  if (typeof rawEnabled === 'object' && rawEnabled !== null) {
    for (const [id, on] of Object.entries(rawEnabled as Record<string, unknown>)) if (on === true) enabled[id] = true;
  }

  const hasSplit = typeof r.appAddress === 'string' || typeof r.apiAddress === 'string';
  const legacyAddress = typeof r.address === 'string' && r.address !== '' ? r.address : null;
  const isCloudUpgrade =
    DEFAULT_APP_ADDRESS === 'https://app.ludy.vn' &&
    DEFAULT_API_ADDRESS === 'https://api.ludy.vn' &&
    legacyAddress === 'https://app.ludy.vn';
  const sameOrigins = hasSplit
    ? r.appAddress === DEFAULT_APP_ADDRESS && r.apiAddress === DEFAULT_API_ADDRESS
    : legacyAddress === DEFAULT_API_ADDRESS || isCloudUpgrade;

  const accounts: Record<string, Account> = {};
  if (sameOrigins && typeof r.accounts === 'object' && r.accounts !== null) {
    for (const [orgId, rawAccount] of Object.entries(r.accounts as Record<string, unknown>)) {
      const a = rawAccount as Partial<Account> | null;
      if (
        a &&
        typeof a.token === 'string' &&
        typeof a.orgSlug === 'string' &&
        typeof a.expiresAt === 'string' &&
        (a.tokenId === undefined || typeof a.tokenId === 'string') &&
        a.orgId === orgId
      ) {
        accounts[orgId] = a as Account;
      }
    }
  }

  const activeOrg = typeof r.activeOrg === 'string' && r.activeOrg in accounts ? r.activeOrg : (Object.keys(accounts)[0] ?? null);
  return {
    appAddress: DEFAULT_APP_ADDRESS,
    apiAddress: DEFAULT_API_ADDRESS,
    accounts,
    activeOrg,
    enabled,
  };
}

export async function loadState(area: StorageArea): Promise<State> {
  return readState((await area.get(KEY))[KEY]);
}

export const saveState = (area: StorageArea, state: State): Promise<void> => area.set({ [KEY]: state });

export function withAccount(state: State, account: Account): State {
  return { ...state, accounts: { ...state.accounts, [account.orgId]: account }, activeOrg: account.orgId };
}

export function withoutAccount(state: State, orgId: string): State {
  const { [orgId]: _gone, ...accounts } = state.accounts;
  return { ...state, accounts, activeOrg: state.activeOrg === orgId ? (Object.keys(accounts)[0] ?? null) : state.activeOrg };
}

export const activeAccount = (state: State): Account | null => (state.activeOrg ? (state.accounts[state.activeOrg] ?? null) : null);

export const withFeature = (state: State, id: string, on: boolean): State => ({ ...state, enabled: { ...state.enabled, [id]: on } });

export interface CaptureDraft {
  kind: 'note' | 'todo';
  title: string;
  body: string;
  tags: string;
  details: string;
  dueOn: string;
  sourceUrl: string | null;
}

export interface CaptureScopeState {
  draft: CaptureDraft;
  status: string;
  busy: boolean;
}

export interface CaptureOp {
  isLive: () => boolean;
  isActive: () => boolean;
  end: () => void;
}

export const emptyCaptureDraft = (): CaptureDraft => ({
  kind: 'note',
  title: '',
  body: '',
  tags: '',
  details: '',
  dueOn: '',
  sourceUrl: null,
});

export function captureScopeKey(apiUrl: string, orgId: string | null | undefined): string | null {
  if (!apiUrl || !orgId) return null;
  return `${apiUrl}\u0000${orgId}`;
}

/**
 * Keeps in-memory Quick Capture drafts and pending async capture operations isolated by `(apiUrl, orgId)`,
 * clearing drafts and invalidating stale completions on sign-out or server change (#3742).
 */
export function createCaptureDraftStore() {
  const scopes = new Map<string, CaptureScopeState>();
  const generations = new Map<string, number>();
  let activeKey: string | null = null;

  const generationOf = (key: string): number => generations.get(key) ?? 0;

  const deleteKey = (key: string) => {
    scopes.delete(key);
    generations.set(key, generationOf(key) + 1);
    if (activeKey === key) activeKey = null;
  };

  const ensureScope = (key: string): CaptureScopeState => {
    let entry = scopes.get(key);
    if (!entry) {
      entry = { draft: emptyCaptureDraft(), status: '', busy: false };
      scopes.set(key, entry);
    }
    return entry;
  };

  return {
    syncState(state: Pick<State, 'apiAddress' | 'accounts' | 'activeOrg'>): { changed: boolean; key: string | null } {
      for (const key of scopes.keys()) {
        const sep = key.indexOf('\u0000');
        const apiUrl = key.slice(0, sep);
        const orgId = key.slice(sep + 1);
        if (apiUrl !== state.apiAddress || !Object.hasOwn(state.accounts, orgId)) {
          deleteKey(key);
        }
      }
      const nextKey = captureScopeKey(state.apiAddress, state.activeOrg);
      const changed = nextKey !== activeKey;
      activeKey = nextKey;
      return { changed, key: nextKey };
    },

    activeKey(): string | null {
      return activeKey;
    },

    get(apiUrl: string, orgId: string): CaptureScopeState {
      const key = captureScopeKey(apiUrl, orgId);
      if (!key) return { draft: emptyCaptureDraft(), status: '', busy: false };
      return ensureScope(key);
    },

    clearScope(apiUrl: string, orgId: string | null | undefined): void {
      const key = captureScopeKey(apiUrl, orgId);
      if (key) deleteKey(key);
    },

    clearAll(): void {
      for (const key of scopes.keys()) {
        generations.set(key, generationOf(key) + 1);
      }
      scopes.clear();
      activeKey = null;
    },

    beginOp(apiUrl: string, orgId: string): { scope: CaptureScopeState; op: CaptureOp } | null {
      const key = captureScopeKey(apiUrl, orgId);
      if (!key) return null;
      const scope = ensureScope(key);
      if (scope.busy) return null;
      scope.busy = true;
      const startedGen = generationOf(key);
      let ended = false;
      const isLive = () => generationOf(key) === startedGen && scopes.get(key) === scope;
      return {
        scope,
        op: {
          isLive,
          isActive: () => isLive() && activeKey === key,
          end: () => {
            if (ended) return;
            ended = true;
            if (isLive()) scope.busy = false;
          },
        },
      };
    },
  };
}
