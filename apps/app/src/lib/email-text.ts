// SPDX-License-Identifier: AGPL-3.0-only
// An email shown as a chat bubble (#2439, plan docs/plan/conversations.md section 6.7): the new text on top, the quoted history and the
// signature folded behind "show quoted text". The stored body is the whole text, so this is a display rule only and a wrong cut loses nothing. No
// React imports, so it is unit tested.

export interface SplitEmail {
  // What the sender wrote this time.
  fresh: string;
  // The history quoted under it, and the signature, as written; empty when there is none.
  quoted: string;
}

// "On <date>, <name> wrote:" and its Vietnamese form; a client may wrap it onto a second line, so the line and the next are both tried.
const WROTE = [/^on .{3,300} wrote:$/i, /^vào .{3,300} đã viết:$/i];
const RULE = /^-{2,}\s*(?:original message|forwarded message|thư gốc|tin nhắn gốc)\s*-{2,}$/i;
const HEADER = /^(?:from|từ):\s/i;
const NEXT_HEADER = /^(?:sent|date|to|subject|gửi|ngày|tới|đến|chủ đề):/i;

// For each line, whether it and every line after it is blank or a "> quoted" line, computed in one pass.
function quoteTail(lines: readonly string[]): boolean[] {
  const tail = Array.from({ length: lines.length }, () => false);
  let all = true;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    all = all && (t === '' || t.startsWith('>'));
    tail[i] = all;
  }
  return tail;
}

function startsQuote(lines: readonly string[], i: number, tail: readonly boolean[]): boolean {
  const line = (lines[i] ?? '').trim();
  const next = (lines[i + 1] ?? '').trim();
  if (line === '') return false;
  if (RULE.test(line) || /^_{10,}$/.test(line) || line === '--') return true;
  if (WROTE.some((re) => re.test(line) || re.test(`${line} ${next}`))) return true;
  // The header block a forwarded or Outlook-style reply repeats: "From:" followed by another header, so a sentence that begins "From:" stays.
  if (HEADER.test(line) && NEXT_HEADER.test(next)) return true;
  // A trailing block of "> quoted" lines.
  return line.startsWith('>') && tail[i] === true;
}

export function splitQuoted(body: string): SplitEmail {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const tail = quoteTail(lines);
  const cut = lines.findIndex((_, i) => startsQuote(lines, i, tail));
  if (cut <= 0) return { fresh: body.trim(), quoted: '' };
  const fresh = lines.slice(0, cut).join('\n').trim();
  // A mail that is all quote (a forward with no comment) is shown whole rather than as an empty bubble.
  if (fresh === '') return { fresh: body.trim(), quoted: '' };
  return { fresh, quoted: lines.slice(cut).join('\n').trim() };
}
