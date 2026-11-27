// SPDX-License-Identifier: AGPL-3.0-only
// Casso Open Platform IDKit transport adapter (CRM plan section 10.1, #4988, TC1).
// Every outbound request passes through @ludy/kernel-runtime guardedRequest (HTTPS only, host openapi.casso.vn,
// zero redirects, 64 KB cap, 5 s deadline).
import {
  CASSO_API_HOST,
  TAX_LOOKUP_MAX_BYTES,
  TAX_LOOKUP_TIMEOUT_MS,
  TaxLookupUpstreamError,
  createCassoTaxLookupProvider,
  type PartyTaxLookupOptions,
  type TaxLookupHttpRequest,
  type TaxLookupProvider,
} from '@ludy/kernel';
import { EgressError, guardedRequest, type EgressOptions, type Runtime } from '@ludy/kernel-runtime';

const runtimeAdapters = new WeakMap<Runtime, PartyTaxLookupOptions>();

export function bindPartyTaxLookupAdapter(runtime: Runtime, options: PartyTaxLookupOptions): void {
  runtimeAdapters.set(runtime, options);
}

export function getPartyTaxLookupAdapter(runtime: Runtime): PartyTaxLookupOptions | undefined {
  return runtimeAdapters.get(runtime);
}

export interface GuardedCassoOptions {
  appId: string;
  appSecret: string;
  timeoutMs?: number;
  now?: () => number;
  requestImpl?: typeof guardedRequest;
  resolve?: EgressOptions['resolve'];
}

export function createGuardedTaxLookupRequest(options?: {
  requestImpl?: typeof guardedRequest;
  resolve?: EgressOptions['resolve'];
}): TaxLookupHttpRequest {
  const runRequest = options?.requestImpl ?? guardedRequest;
  const resolve = options?.resolve;

  return async (url, req, signal) => {
    if (signal?.aborted) {
      throw new TaxLookupUpstreamError('timeout', 'Casso tax lookup aborted before request');
    }
    const egressOptions: EgressOptions = {
      httpsOnly: true,
      hostAllowed: (host) => host.toLowerCase() === CASSO_API_HOST,
      maxRedirects: 0,
      timeoutMs: Math.min(Math.max(1, req.timeoutMs), TAX_LOOKUP_TIMEOUT_MS),
      maxBytes: Math.min(Math.max(1, req.maxBytes), TAX_LOOKUP_MAX_BYTES),
      overLimit: 'fail',
      ...(resolve ? { resolve } : {}),
    };

    const call = runRequest(
      url,
      {
        method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: Buffer.from(req.body, 'utf8') } : {}),
      },
      egressOptions,
    );

    const response = await (signal
      ? new Promise<Awaited<typeof call>>((resolvePromise, rejectPromise) => {
          const onAbort = () => {
            rejectPromise(new TaxLookupUpstreamError('timeout', 'Casso tax lookup timed out'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          call.then(
            (res) => {
              signal.removeEventListener('abort', onAbort);
              resolvePromise(res);
            },
            (err: unknown) => {
              signal.removeEventListener('abort', onAbort);
              rejectPromise(err);
            },
          );
        })
      : call
    ).catch((error: unknown) => {
      if (error instanceof TaxLookupUpstreamError) throw error;
      if (error instanceof EgressError) {
        if (error.code === 'timeout') {
          throw new TaxLookupUpstreamError('timeout', error.message);
        }
        if (error.code === 'blocked' || error.code === 'invalid_url' || error.code === 'redirects') {
          throw new TaxLookupUpstreamError('egress_blocked', error.message);
        }
        throw new TaxLookupUpstreamError('unavailable', error.message);
      }
      throw new TaxLookupUpstreamError(
        'unavailable',
        error instanceof Error ? error.message : 'Casso tax lookup request failed',
      );
    });

    return {
      status: response.status,
      headers: { ...response.headers },
      body: response.body,
    };
  };
}

export function createGuardedCassoTaxLookupProvider(options: GuardedCassoOptions): TaxLookupProvider {
  const request = createGuardedTaxLookupRequest({
    ...(options.requestImpl ? { requestImpl: options.requestImpl } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
  });
  return createCassoTaxLookupProvider({
    appId: options.appId,
    appSecret: options.appSecret,
    request,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
