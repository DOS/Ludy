// SPDX-License-Identifier: AGPL-3.0-only
// The languages a member may translate a meeting into (E3, #3186): the picker's pure parts, shared by the summary card and the transcript panel and their tests.
import type { TranslationTarget } from '@crove/kernel-contract';

// The BCP 47 tag of a translated text, so a browser picks a font and line breaking for it: Chinese here is Simplified (the server asks the model for Simplified Chinese), the others are their own tags.
export function langTag(to: string): string {
  return to === 'zh' ? 'zh-Hans' : to;
}

// Whether a choice is worth showing: the status lists the other language of the pair and each language the deployment has switched on, so with only one there is nothing to pick (and the screens are as before the picker).
export function hasChoice(targets: readonly TranslationTarget[] | undefined): boolean {
  return (targets?.length ?? 0) > 1;
}

// The target a screen asks for: what the member picked while the server still offers it, else none (the server then takes the other language of the pair).
export function pickedTarget(picked: TranslationTarget | undefined, targets: readonly TranslationTarget[] | undefined): TranslationTarget | undefined {
  return picked !== undefined && targets?.includes(picked) ? picked : undefined;
}
