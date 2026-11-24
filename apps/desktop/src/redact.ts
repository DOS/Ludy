// SPDX-License-Identifier: AGPL-3.0-only
// Nothing secret reaches a log line: the shell's tokens (`crx_`), one-time codes (`crc_`) and anything shaped like a PKCE verifier are
// replaced before a message is written. The logger is the only place the shell writes text outside the tray.
const SECRET = /\b(?:crx|crc)_[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/g;

export function redact(text: string): string {
  return text.replace(SECRET, '[redacted]');
}

export type Logger = (message: string) => void;

export function createLogger(write: (line: string) => void): Logger {
  return (message) => write(redact(message));
}
