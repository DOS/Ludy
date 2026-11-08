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
    if (a && typeof a.token === 'string' && typeof a.orgSlug === 'string' && typeof a.expiresAt === 'string' && a.orgId === orgId) accounts[orgId] = a;
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
