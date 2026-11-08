// SPDX-License-Identifier: AGPL-3.0-only
// The branded type of text that came from a member's private data (ADR-0049 decision 4, layer 3): a reader that returns what a member's own
// context could read, and Vy's output built from it, returns PrivateText, never a plain string. The org-level features of this package accept
// plain strings only, and a static test (packages/agent/test/invariant/member-vy-boundary.test.ts) fails when one of them names this type or
// imports a member-Vy module, so a private text cannot be handed to an org-level feature by accident. The two functions below are the only
// ways in and out of the brand: wrapping says "this is private", unwrapping is an explicit act the reader of the code can see.
declare const privateBrand: unique symbol;
export type PrivateText = string & { readonly [privateBrand]: 'PrivateText' };

export function privateText(value: string): PrivateText {
  return value as PrivateText;
}

export function revealPrivateText(value: PrivateText): string {
  return value;
}
