// SPDX-License-Identifier: AGPL-3.0-only
// Entry point for @crove/sign: exports the CA signing port, SSRF-safe URL helpers,
// offline sandbox adapter, VNPT SmartCA / Viettel MySign / MISA WeSign adapters, and getCaAdapter factory.
import { createMisaWeSignAdapter } from './misa-wesign.ts';
import {
  CaProviderError,
  isCaProvider,
  type CaAdapterOptions,
  type CaProviderId,
  type CaSigningAdapter,
} from './port.ts';
import { createSandboxCaAdapter } from './sandbox.ts';
import { createViettelMySignAdapter } from './viettel-mysign.ts';
import { createVnptSmartCaAdapter } from './vnpt-smartca.ts';

export * from './port.ts';
export * from './sandbox.ts';
export * from './vnpt-smartca.ts';
export * from './viettel-mysign.ts';
export * from './misa-wesign.ts';
export { assertSafeCaBaseUrl, assertSafeCaRequestUrl, isSafePublicFqdn, isValidDerSequence } from './http.ts';

export function getCaAdapter(provider: CaProviderId, options: CaAdapterOptions = {}): CaSigningAdapter {
  if (!isCaProvider(provider)) {
    throw new CaProviderError('invalid_request', 'unsupported CA provider');
  }
  switch (provider) {
    case 'sandbox':
      return createSandboxCaAdapter(options.now ? { now: options.now } : {}).adapter;
    case 'vnpt_smartca':
      return createVnptSmartCaAdapter(options);
    case 'viettel_mysign':
      return createViettelMySignAdapter(options);
    case 'misa_wesign':
      return createMisaWeSignAdapter(options);
  }
}
