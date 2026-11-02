// SPDX-License-Identifier: AGPL-3.0-only
// The key a bank statement line's text gives a learned party rule (issue #2402). Banks print the same counterparty with
// different transfer words, references, dates and numbers each time ("CK TU NGUYEN VAN A TT TIEN NHA T9 FT26301..."), so the
// key keeps only what stays: the longest run of consecutive distinctive words, after the transfer words, bank codes and
// every token with a digit are dropped. Pure and deterministic; the key is hashed by the database
// (crove_finance.bank_party_rule_hash) before it is stored, so no text of a line is ever kept.
import { foldVietnamese } from './portal-status.ts';

// Words and phrases of a bank statement that say nothing about the counterparty, folded (no diacritics, lower case). A phrase
// is dropped whole, longest first. Matched on folded whole words only.
export const BANK_NOISE_PHRASES: readonly string[] = [
  'ma giao dich',
  'chuyen khoan',
  'chuyen tien',
  'thanh toan',
  'giao dich',
  'noi dung',
  'nhan tu',
  'trich no',
];
export const BANK_NOISE_WORDS: readonly string[] = [
  // Transfer words and channels.
  'ck', 'tt', 'nd', 'ibft', 'napas', 'ft', 'trace', 'ref', 'ib', 'qr', 'vietqr', 'banking', 'bank', 'nh', 'stk',
  // Invoice and month words of a payment reason.
  'hd', 'mst', 'thang', 'nam',
  // Prepositions the banks put around the names.
  'tu', 'den', 'qua', 'cho', 'cua', 'va',
  // Bank codes and names.
  'mb', 'vcb', 'bidv', 'ctg', 'vtb', 'acb', 'tcb', 'mbb', 'vpb', 'tpb', 'stb', 'shb', 'hdb', 'ocb', 'msb', 'eib', 'lpb', 'vib', 'scb', 'abb', 'bab', 'bvb', 'nab', 'seab', 'vab',
  'vietcombank', 'techcombank', 'vietinbank', 'agribank', 'sacombank', 'mbbank', 'vpbank', 'tpbank', 'maritimebank',
];
const PHRASES = BANK_NOISE_PHRASES.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);
const NOISE = new Set(BANK_NOISE_WORDS);

// The shortest key (characters, spaces included) a rule may have: a shorter one points at too many parties.
export const BANK_KEY_MIN_CHARS = 3;
// The longest key kept, characters.
export const BANK_KEY_MAX_CHARS = 100;

// The key of a line's description, or null when it has none (nothing distinctive left, or fewer than BANK_KEY_MIN_CHARS characters).
export function bankLineKey(description: string): string | null {
  const tokens = foldVietnamese(description)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  // A dropped token breaks the run: words a number or a transfer word separates are not one name.
  const runs: string[][] = [[]];
  for (let i = 0; i < tokens.length; ) {
    const phrase = PHRASES.find((p) => p.every((w, k) => tokens[i + k] === w));
    if (phrase) {
      runs.push([]);
      i += phrase.length;
      continue;
    }
    const token = tokens[i] as string;
    i += 1;
    if (/[0-9]/.test(token) || NOISE.has(token)) {
      runs.push([]);
      continue;
    }
    (runs[runs.length - 1] as string[]).push(token);
  }
  // The longest run by characters; the first on a tie.
  let best: string[] = [];
  for (const run of runs) if (run.join(' ').length > best.join(' ').length) best = run;
  const key = best.join(' ').slice(0, BANK_KEY_MAX_CHARS).trim();
  return key.length >= BANK_KEY_MIN_CHARS ? key : null;
}
