// SPDX-License-Identifier: AGPL-3.0-only
// Carrying an open item of the previous meeting of a series into the recorder's own notes of this one (#3542): one plain line, appended to what they have written. Pure text: nothing here
// reads or writes anything, and the notes are saved by the existing command.
import { NOTES_BODY_MAX } from '@ludy/kernel-contract';

/** The line an item becomes in the notes: "- title (who)", on one line, with no marks a note box would read as more lines. */
export function noteLineFor(title: string, who: string): string {
  const one = (text: string) => text.replace(/\s+/g, ' ').trim();
  const name = one(who);
  return `- ${one(title)}${name === '' ? '' : ` (${name})`}`;
}

/** The notes with the line added at the end, or null when the notes would pass the limit a note may have (the recorder frees room first; nothing is cut). A line already there is not added twice. */
export function appendNoteLine(body: string, line: string, max: number = NOTES_BODY_MAX): string | null {
  if (body.split('\n').some((existing) => existing.trim() === line)) return body;
  const next = body.trim() === '' ? line : `${body.trimEnd()}\n${line}`;
  return next.length > max ? null : next;
}
