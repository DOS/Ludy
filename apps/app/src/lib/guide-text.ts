// SPDX-License-Identifier: AGPL-3.0-only
// What the guides (quick-guide.ts, crm-guide.ts) share (issue #3596): a step's shape, the quoting of a label, and the
// filling of the product name. A guide is written once per interface language and quotes the buttons and screens by
// the labels of that language's own catalog, so a renamed button renames it here too.
import { withBrand } from '../i18n/brand.ts';
import type { Locale } from '../i18n/locale.ts';
import { SOURCE_CATALOGS } from '../i18n/runtime.ts';

export type GuideCatalog = (typeof SOURCE_CATALOGS)[Locale];

export interface GuideStep<Id extends string = string> {
  id: Id;
  title: string;
  items: readonly string[];
}

// A label as the guide quotes it.
export const quote = (label: string): string => `"${label}"`;

// A catalog label with its ICU placeholders filled in: "Duyệt {count, number} đề xuất" with { count: 'N' } reads
// "Duyệt N đề xuất".
export function fill(label: string, values: Readonly<Record<string, string>>): string {
  return label.replace(/\{(\w+)(?:,[^}]*)?\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? (values[name] ?? whole) : whole));
}

// A guide's text per interface language, as a function of that language's catalog.
export type GuideTexts<Id extends string> = Record<Locale, (m: GuideCatalog) => readonly GuideStep<Id>[]>;

// The steps of a guide in one locale: the catalog of that locale handed to the text, and the product name filled in
// (BRAND_NAME, issue #1040).
export function buildGuide<Id extends string>(texts: GuideTexts<Id>, brand: string, locale: Locale): readonly GuideStep<Id>[] {
  return texts[locale](SOURCE_CATALOGS[locale]).map((step) => ({ ...step, title: withBrand(step.title, brand), items: step.items.map((item) => withBrand(item, brand)) }));
}
