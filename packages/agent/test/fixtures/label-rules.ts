// SPDX-License-Identifier: AGPL-3.0-only
// Stand-in label rules for the label suggestion's unit tests (#5010). The kernel hands the real ones (the contract's, the ones a label the recorder types meets) to the checks; this package does not import the contract
// (the dependency rules forbid a path into another package), so these small rules keep the same shape: spaces folded, 1 to 40 characters, no control or invisible character, no "@", no run of seven digits. The route
// test in apps/kernel/test runs the checks with the contract's own rules.
import type { LabelRules } from '../../src/member-vy/index.ts';

const fold = (text: string): string => text.normalize('NFC').replace(/[ \t]+/g, ' ').trim();
const invisible = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
const refused = (text: string): boolean => {
  const clean = fold(text);
  return clean === '' || [...clean].length > 40 || [...clean].some((ch) => invisible(ch.codePointAt(0) ?? 0)) || clean.includes('@') || /\d(?:[\s.\-/()+]?\d){6,}/.test(clean);
};

export const LABEL_RULES: LabelRules = { clean: (text) => (refused(text) ? null : fold(text)), key: (text) => fold(text).toLowerCase(), maxLabels: 5 };
