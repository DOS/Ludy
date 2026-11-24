// SPDX-License-Identifier: AGPL-3.0-only
// Where the member's token lives. Only as a blob encrypted by the OS key store (Electron safeStorage: DPAPI on Windows, the login keychain
// on macOS), in a file only this user can read. Never plain text, never localStorage, never a log. When the OS cannot encrypt (no
// key store, or Linux's plain-text fallback) nothing is written: the session lives in memory and ends with the process.
// The stored session is bound to the Ludy address it was issued by; a different configured address ignores it, so the token never
// travels to another server.
export interface StoredSession {
  ludyUrl: string;
  token: string;
  tokenId: string;
  orgId: string;
  orgSlug: string;
  expiresAt: string;
  scopes?: string[];
}

export interface SecretBox {
  isAvailable(): boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(blob: Uint8Array): string;
}

export interface FileIO {
  read(path: string): Promise<Uint8Array | null>;
  // Written readable by the owner only.
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export type SaveResult = 'persisted' | 'memory-only';

export interface SessionStore {
  // The session for this Ludy address, or null.
  load(ludyUrl: string): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<SaveResult>;
  clear(): Promise<void>;
}

const VERSION = 1;

function isStored(value: unknown): value is StoredSession {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!['ludyUrl', 'token', 'tokenId', 'orgId', 'orgSlug', 'expiresAt'].every((key) => typeof v[key] === 'string' && (v[key] as string).length > 0)) {
    return false;
  }
  return v.scopes === undefined || (Array.isArray(v.scopes) && v.scopes.every((s) => typeof s === 'string'));
}

export function createSessionStore(options: { file: string; box: SecretBox; io: FileIO }): SessionStore {
  const { file, box, io } = options;
  let memory: StoredSession | null = null;
  return {
    async load(ludyUrl) {
      if (memory === null) {
        const blob = await io.read(file);
        if (blob !== null && box.isAvailable()) {
          try {
            const parsed = JSON.parse(box.decrypt(blob)) as { v?: unknown; session?: unknown };
            if (parsed.v === VERSION && isStored(parsed.session)) memory = parsed.session;
          } catch {
            // Unreadable or from another user or machine: it is dropped below like any other bad blob.
          }
          if (memory === null) await io.remove(file).catch(() => undefined);
        }
      }
      return memory !== null && memory.ludyUrl === ludyUrl ? memory : null;
    },
    async save(session) {
      memory = session;
      if (!box.isAvailable()) {
        await io.remove(file).catch(() => undefined);
        return 'memory-only';
      }
      await io.write(file, box.encrypt(JSON.stringify({ v: VERSION, session })));
      return 'persisted';
    },
    async clear() {
      memory = null;
      await io.remove(file).catch(() => undefined);
    },
  };
}
