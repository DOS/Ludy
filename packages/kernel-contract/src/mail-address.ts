// SPDX-License-Identifier: AGPL-3.0-only
// One mailbox address, exactly (#2439, security review of #2528). A mail library reads "a@x.test,b@y.test" from one From header as a single
// address, and a mailer reads the same string as two recipients, so an address that reaches a sender or a recipient field is checked here first: one
// addr-spec, no display name, no list, no comment, no quoted local part.
//
// The local part is the dot-atom of RFC 5322 (letters, digits and the characters ! # $ % & ' * + / = ? ^ _ ` { | } ~ -, in dot-separated parts);
// the domain is dot-separated labels of letters, digits and hyphens (a label neither begins nor ends with a hyphen), at least two of them. Internationalized
// names arrive in their ASCII form (punycode). Lengths are the protocol's: 64 for the local part, 253 for the domain, 254 in all.
const LOCAL_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL = new RegExp(`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*$`);
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isMailAddress(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length > 253 || !LOCAL.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}
