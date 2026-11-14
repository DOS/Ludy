// SPDX-License-Identifier: AGPL-3.0-only
// The few `chrome.*` calls the extension makes, typed by hand so the package carries no third-party dependency
// (ADR-0047 point 10: dependencies pinned and few). Add a member here only when the code uses it.
declare namespace chrome {
  namespace runtime {
    const id: string | undefined;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function getManifest(): { name?: string; description?: string; version: string; permissions?: string[]; optional_permissions?: string[]; host_permissions?: string[]; icons?: Record<string, string> };
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: {
      addListener(listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
    function getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;
  }
  namespace i18n {
    function getUILanguage(): string;
  }
  namespace storage {
    interface Area {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: Area;
  }
  namespace identity {
    function launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
    function getRedirectURL(path?: string): string;
  }
  namespace permissions {
    function contains(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    function request(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    function remove(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  }
  namespace tabs {
    interface Tab {
      id?: number;
    }
    function query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    function create(properties: { url: string }): Promise<Tab>;
  }
  namespace tabCapture {
    function getMediaStreamId(options: { targetTabId: number }): Promise<string>;
  }
  namespace offscreen {
    function createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
  }
  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    function setTitle(details: { title: string }): Promise<void>;
  }
}
