// SPDX-License-Identifier: AGPL-3.0-only
// The system browser for the sign-in (expo-web-browser): ASWebAuthenticationSession on iOS and a Chrome Custom Tab on Android,
// the person's own browser with its own address bar, never a webview inside this app that could read the password. The iOS
// session is ephemeral: it neither reads nor leaves the Safari cookies, so signing out of the app and in again asks for the
// account again instead of silently continuing the last one.
import * as WebBrowser from 'expo-web-browser';
import type { BrowserPort } from '../auth/session.ts';

export const systemBrowser: BrowserPort = {
  async open(url, redirectUri) {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true });
    return result.type === 'success' ? { type: 'success', url: result.url } : { type: 'cancel' };
  },
};
