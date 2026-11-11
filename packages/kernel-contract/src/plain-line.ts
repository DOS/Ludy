// SPDX-License-Identifier: AGPL-3.0-only
// Text a person typed or an import brought, as ONE plain line for a reader outside the org: an AI app an owner connected over MCP (ADR-0051, #2975). The text
// reaches a language model, so "plain" means what the model can read as well as what a person can see:
//  - format characters are dropped (zero-width and bidi controls, the soft hyphen, and the Unicode tag characters U+E0000 to U+E007F, which are invisible and which a
//    model still reads: a public booking form can put them in a contact's name), and so are private-use, unassigned and surrogate code points;
//  - control characters and the line and paragraph separators (U+2028, U+2029) become a space, runs of space collapse into one, and the ends are trimmed;
//  - it is cut at `max` characters (code points) and trimmed again, so the cut leaves no trailing space.
// The text stays data for the client: the tool's description says so; this removes the cheap channels, it does not make a model immune.
export function plainLine(value: string, max: number): string {
  const dropped = value.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]+/gu, '');
  const spaced = dropped.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
  return [...spaced].slice(0, max).join('').trim();
}
