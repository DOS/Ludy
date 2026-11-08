// SPDX-License-Identifier: AGPL-3.0-only
// The branded type of text that came from a member's private data (ADR-0049 decision 4, layer 3): a reader that returns what a member's own
// context could read, and Vy's output built from it, returns PrivateText, never a plain string. PrivateText is NOT a string type: it cannot be
// passed where a string is accepted (a logger, an Error message, a template literal, an org-level feature), and at runtime it is a frozen object
// whose JSON form, string form and inspection all print "[private]". The text lives in a module-private WeakMap, so the only way out is
// revealPrivateText, an explicit act the reader of the code can see. A static test (packages/agent/test/invariant/member-vy-boundary.test.ts)
// also fails when an org-level feature names this type or imports a member-Vy module.
declare const privateBrand: unique symbol;
export type PrivateText = { readonly [privateBrand]: true };

const texts = new WeakMap<object, string>();
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export function privateText(value: string): PrivateText {
  const wrapper = Object.freeze({
    toJSON: () => '[private]',
    toString: () => '[private]',
    [INSPECT]: () => '[private]',
  });
  texts.set(wrapper, value);
  return wrapper as unknown as PrivateText;
}

export function revealPrivateText(value: PrivateText): string {
  const text = texts.get(value as unknown as object);
  if (text === undefined) throw new Error('not a PrivateText made by privateText()');
  return text;
}
