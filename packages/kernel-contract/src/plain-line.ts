// SPDX-License-Identifier: AGPL-3.0-only
// Text a person typed or an import brought, as ONE plain line for a reader outside the org: an AI app an owner connected over MCP (ADR-0051, #2975). The text
// reaches a language model, so "plain" means what the model can read as well as what a person can see:
//  - format characters are dropped (zero-width and bidi controls, the soft hyphen, and the Unicode tag characters U+E0000 to U+E007F, which are invisible and which a
//    model still reads: a public booking form can put them in a contact's name), and so are private-use, unassigned and surrogate code points;
//  - control characters and the line and paragraph separators (U+2028, U+2029) become a space, runs of space collapse into one, and the ends are trimmed;
//  - it is cut at `max` characters (code points) and trimmed again, so the cut leaves no trailing space.
// The text stays data for the client: the tool's description says so; this removes the cheap channels, it does not make a model immune.
const DROPPED_LINE_CHARS_RE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\u115f\u1160\u180b-\u180d\u2800\u3164\uffa0]+|\u034f/gu;

export function plainLine(value: string, max: number): string {
  const dropped = value.replace(DROPPED_LINE_CHARS_RE, '');
  const spaced = dropped.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  return [...spaced].slice(0, max).join('').trim();
}

// A longer text of a customer (a message, an email) for the same reader, keeping its line breaks: the invisible characters of plainLine are dropped, tabs and other control characters become a space,
// a carriage return pairs with a line feed or becomes one, runs of blank lines collapse into one blank line, lines are trimmed at the end, and the whole is cut at `max` characters (code points).
// `truncated` is true when more than `max` characters were left out. Still data for the client, never an instruction.
export function plainText(value: string, max: number): { text: string; truncated: boolean } {
  const dropped = value.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]+/gu, '');
  const lines = dropped
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Zl}\p{Zp}]+/gu, '\n')
    .replace(/[^\P{Cc}\n]+/gu, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trimEnd());
  const whole = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const points = [...whole];
  const text = points.slice(0, max).join('').trim();
  return { text, truncated: points.length > max };
}
