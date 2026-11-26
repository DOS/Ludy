// SPDX-License-Identifier: AGPL-3.0-only
// What the extension keeps in its own storage (chrome.storage.local, visible to this extension only): the Ludy address,
// one connected account per org (the extension token and the org's slug) and which features the member turned on. The
// token is the only secret; the kernel stores its hash. A token belongs to one address, so changing the address drops
// every account.
import { DEFAULT_ADDRESS } from './ludy-address.ts';

export interface Account {
  orgId: string;
  orgSlug: string;
  token: string;
  expiresAt: string;
  tokenId?: string;
}

export interface State {
  address: string;
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

export const emptyState = (): State => ({ address: DEFAULT_ADDRESS, accounts: {}, activeOrg: null, enabled: {} });

// Whatever storage holds is checked, not trusted: a damaged value reads as the empty state.
export function readState(raw: unknown): State {
  if (typeof raw !== 'object' || raw === null) return emptyState();
  const r = raw as Partial<State>;
  const accounts: Record<string, Account> = {};
  for (const [orgId, a] of Object.entries(r.accounts ?? {})) {
    if (
      a &&
      typeof a.token === 'string' &&
      typeof a.orgSlug === 'string' &&
      typeof a.expiresAt === 'string' &&
      (a.tokenId === undefined || typeof a.tokenId === 'string') &&
      a.orgId === orgId
    ) {
      accounts[orgId] = a;
    }
  }
  const enabled: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(r.enabled ?? {})) if (on === true) enabled[id] = true;
  const activeOrg = typeof r.activeOrg === 'string' && r.activeOrg in accounts ? r.activeOrg : (Object.keys(accounts)[0] ?? null);
  return { address: typeof r.address === 'string' && r.address !== '' ? r.address : DEFAULT_ADDRESS, accounts, activeOrg, enabled };
}

export async function loadState(area: StorageArea): Promise<State> {
  return readState((await area.get(KEY))[KEY]);
}

export const saveState = (area: StorageArea, state: State): Promise<void> => area.set({ [KEY]: state });

export const withAddress = (state: State, address: string): State => (address === state.address ? state : { ...emptyState(), address, enabled: state.enabled });

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

export function captureScopeKey(serverUrl: string, orgId: string | null | undefined): string | null {
  if (!serverUrl || !orgId) return null;
  return `${serverUrl}\u0000${orgId}`;
}

/**
 * Keeps in-memory Quick Capture drafts and pending async capture operations isolated by `(serverUrl, orgId)`,
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
    syncState(state: Pick<State, 'address' | 'accounts' | 'activeOrg'>): { changed: boolean; key: string | null } {
      for (const key of scopes.keys()) {
        const sep = key.indexOf('\u0000');
        const serverUrl = key.slice(0, sep);
        const orgId = key.slice(sep + 1);
        if (serverUrl !== state.address || !Object.hasOwn(state.accounts, orgId)) {
          deleteKey(key);
        }
      }
      const nextKey = captureScopeKey(state.address, state.activeOrg);
      const changed = nextKey !== activeKey;
      activeKey = nextKey;
      return { changed, key: nextKey };
    },

    activeKey(): string | null {
      return activeKey;
    },

    get(serverUrl: string, orgId: string): CaptureScopeState {
      const key = captureScopeKey(serverUrl, orgId);
      if (!key) return { draft: emptyCaptureDraft(), status: '', busy: false };
      return ensureScope(key);
    },

    clearScope(serverUrl: string, orgId: string | null | undefined): void {
      const key = captureScopeKey(serverUrl, orgId);
      if (key) deleteKey(key);
    },

    clearAll(): void {
      for (const key of scopes.keys()) {
        generations.set(key, generationOf(key) + 1);
      }
      scopes.clear();
      activeKey = null;
    },

    beginOp(serverUrl: string, orgId: string): { scope: CaptureScopeState; op: CaptureOp } | null {
      const key = captureScopeKey(serverUrl, orgId);
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
