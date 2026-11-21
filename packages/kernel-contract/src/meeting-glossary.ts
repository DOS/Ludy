// SPDX-License-Identifier: AGPL-3.0-only
// The glossary of an organization (Meetings #4043, design on that issue): the terms (a product, an acronym, a piece of jargon) that Vy should spell the way the org does. An owner or admin
// keeps the list in Settings; nobody else reads or writes it. Step 3 hands the terms to the recorder's own run as data (never as an instruction) for the summary, the translation, the
// chapters and the title; step 4, later, to the transcription provider.
//
// A term is plain text a person typed, so it is cleaned via cleanTemplateText (built from INVISIBLE_PATTERN in ./invisible-chars.ts: control characters, line and paragraph separators,
// bidirectional controls, zero-width and invisible characters, tag characters, unpaired surrogates; whitespace collapsed) and normalized to NFC, then judged by the same rules as the term list of
// the transcription (`normalizeTerms`): at most 40 characters (code points), no remaining invisible/control characters or lone surrogates, at least one letter, at most 4 digits, no "@", no web
// address. Both the contract (`term.normalize('NFKC')`) and the database (`crove_meetings.glossary_term_ok` via `pg_catalog.normalize(p_term, 'NFKC')` in
// supabase/migrations/20270127250000_crove_meetings_glossary_invisible_chars.sql) check '@', '://' and 'www.' after NFKC folding so full-width '@' and dotted look-alikes are rejected in both
// layers; the app stays stricter only on non-ASCII decimal digits (`\p{Nd}` vs `[[:digit:]]`).
import { z } from 'zod';
import { INVISIBLE_PATTERN } from './invisible-chars.ts';
import { cleanTemplateText } from './meeting-minutes-templates.ts';
import { zId } from './schemas.ts';

export const GLOSSARY_TERM_MAX = 40;
// Terms one organization keeps.
export const GLOSSARY_TERMS_MAX = 60;
// A term with more digits than this is a number (a phone number, a tax code, an amount), not a name.
export const GLOSSARY_TERM_DIGITS_MAX = 4;

const CONTROL = new RegExp(`${INVISIBLE_PATTERN}|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]`, 'u');

// Why a cleaned term is refused, or null when it is a term. The code points are counted, so a name written with surrogate pairs is not cut short.
export function glossaryTermProblem(term: string): string | null {
  if (term === '') return 'A term cannot be empty';
  if (Array.from(term).length > GLOSSARY_TERM_MAX) return `A term has at most ${GLOSSARY_TERM_MAX} characters`;
  if (CONTROL.test(term)) return 'A term cannot contain invisible or control characters';
  if (!/\p{L}/u.test(term)) return 'A term has at least one letter';
  const folded = term.normalize('NFKC');
  if (folded.includes('@') || /:\/\/|www\./i.test(folded)) return 'A term is not an email or web address';
  if ((term.match(/\p{Nd}/gu) ?? []).length > GLOSSARY_TERM_DIGITS_MAX) return `A term has at most ${GLOSSARY_TERM_DIGITS_MAX} digits`;
  return null;
}

// The text as stored: cleaned, in Unicode form C (so one name is one string whatever the keyboard), then judged.
export const zGlossaryTerm = z
  .string()
  .transform((raw) => cleanTemplateText(raw).normalize('NFC'))
  .superRefine((term, ctx) => {
    const problem = glossaryTermProblem(term);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

export const zGlossaryList = z.strictObject({});
export const zGlossaryAdd = z.strictObject({ term: zGlossaryTerm });
export const zGlossaryUpdate = z.strictObject({ termId: zId, term: zGlossaryTerm });
export const zGlossaryRemove = z.strictObject({ termId: zId });

export const zGlossaryTermView = z.strictObject({ id: zId, term: z.string(), createdAt: z.string(), updatedAt: z.string() });
export type GlossaryTermView = z.infer<typeof zGlossaryTermView>;
export const zGlossaryTerms = z.strictObject({ terms: z.array(zGlossaryTermView).max(GLOSSARY_TERMS_MAX) });
export type GlossaryTerms = z.infer<typeof zGlossaryTerms>;
export const zGlossaryDone = z.strictObject({ termId: zId });
export type GlossaryDone = z.infer<typeof zGlossaryDone>;
