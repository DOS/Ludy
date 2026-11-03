// SPDX-License-Identifier: AGPL-3.0-only
// The e-invoice connection card in Settings (#2501, ADR-0044 point 2): what the screen works out from the API's answers. The server decides every rule; these only
// choose what to show.
import type { EInvoiceConnection, EInvoiceConnectionState, EInvoiceSeries } from '@crove/kernel-contract';

// A series symbol read in parts (Circular 91, Appendix I): C (coded by the tax authority) or K, a two-digit year, a type letter, then two characters the seller chose.
// A symbol of any other shape is shown as it is, with no reading.
export interface SymbolParts {
  coded: boolean;
  year: string;
  typeLetter: string;
}
export function decodeSymbol(symbol: string): SymbolParts | null {
  const match = /^([CK])([0-9]{2})([A-Z])[A-Z0-9]{2}$/.exec(symbol);
  return match ? { coded: match[1] === 'C', year: `20${match[2]}`, typeLetter: match[3] as string } : null;
}

// The template numbers the rules name (1 VAT invoice, 2 sales invoice, 7 e-commerce); another number is shown as it is.
export const TEMPLATE_WORDS = { '1': 'tpl1', '2': 'tpl2', '7': 'tpl7' } as const;
export const templateWord = (templateNo: string): (typeof TEMPLATE_WORDS)[keyof typeof TEMPLATE_WORDS] | null => (Object.hasOwn(TEMPLATE_WORDS, templateNo) ? TEMPLATE_WORDS[templateNo as keyof typeof TEMPLATE_WORDS] : null);

// The words for a test state, as message keys.
export const STATE_KEYS = {
  works: 'states.works',
  wrong_credentials: 'states.wrong_credentials',
  api_not_enabled: 'states.api_not_enabled',
  ip_not_allowed: 'states.ip_not_allowed',
  unreachable: 'states.unreachable',
  signing_needs_person: 'states.signing_needs_person',
} as const satisfies Record<EInvoiceConnectionState, string>;

// Whether the e-invoice card draws: the deployment offers a provider to connect, or the org already has a connection (a viewer still reads it when the provider was
// turned off since). While the answers are not in, it does not.
export const einvoiceCardShown = (providers: readonly unknown[] | undefined, connections: readonly unknown[] | undefined): boolean => (providers?.length ?? 0) > 0 || (connections?.length ?? 0) > 0;

// The series a connection issues from: its entity's, under its provider.
export const seriesOf = (series: readonly EInvoiceSeries[], connection: Pick<EInvoiceConnection, 'legalEntityId' | 'provider'>): EInvoiceSeries[] =>
  series.filter((s) => s.legalEntityId === connection.legalEntityId && s.provider === connection.provider);

// A field the org types to connect is a secret unless its name says it is a plain identifier: the input hides what is typed.
export const fieldIsSecret = (name: string): boolean => !/^(user|username|account|email|login|appId|clientId|taxCode)$/i.test(name);
