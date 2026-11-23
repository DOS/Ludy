// SPDX-License-Identifier: AGPL-3.0-only
// The push address of a marketplace connection (#4348, S3b of #4315): the address to paste in the seller's own app on the platform, made by the server and shown once. The address lives only in this component's state: it
// is not in a query key, a URL or storage. It is read in the call's own onSuccess and the mutation is reset at once, so the answer is not kept in the mutation cache or the observer; hiding the address, starting another
// replacement or leaving the card discards what is left. Replacing the address stops the old one at once, so it takes a second click. The status read never carries the address.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MarketplaceConnection } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { hookReduce, hookViewStart } from '../lib/bank-feeds.ts';

// The mutation that makes the address (#4348). Whatever the outcome (even one the page is gone for), the status is read again: an address made but never seen, or an old one that stopped, shows there. The mutation holds its
// answer, the address included, so it has no cache time: it is dropped as soon as nothing watches it, and the card resets it in its own success callback besides.
export function pushHookMutationOptions() {
  return {
    ...orpc.marketplace.connections.pushHookSet.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.marketplace.connections.pushHook.key() }),
    }),
    gcTime: 0,
  };
}

// The address as the owner sees it, once: a read-only field (selected on focus), the two notes, the copy button and "Close". The card focuses the field when the address arrives; the status lines around it stay in the card, always
// drawn, so a screen reader announces them.
export function PushHookAddressBox({
  address,
  replaced,
  inputRef,
  onCopy,
  onHide,
}: {
  address: string;
  replaced: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onCopy: () => void;
  onHide: () => void;
}) {
  const t = useTranslations('marketplaceConnections.pushHook');
  return (
    <div className="space-y-2 rounded-md bg-muted p-2">
      {replaced && <p className="text-xs text-warning">{t('replacedExisting')}</p>}
      <Input ref={inputRef} className="min-h-11 font-mono text-xs" readOnly aria-label={t('addressLabel')} value={address} onFocus={(e) => e.currentTarget.select()} />
      <p className="text-xs text-subtle-foreground">{t('noteExact')}</p>
      <p className="text-xs text-subtle-foreground">{t('noteShared')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={onCopy}>
          {t('copy')}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11" onClick={onHide}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}

export function MarketplacePushHook({ connection }: { connection: MarketplaceConnection }) {
  const t = useTranslations('marketplaceConnections.pushHook');
  const f = useFormat();
  const [view, dispatch] = useReducer(hookReduce, hookViewStart);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const status = useQuery(orpc.marketplace.connections.pushHook.queryOptions({ input: { id: connection.id } }));
  const make = useMutation(pushHookMutationOptions());
  useEffect(() => {
    if (view.address !== null) inputRef.current?.focus();
  }, [view.address]);
  useEffect(() => {
    if (view.confirming) confirmRef.current?.focus();
  }, [view.confirming]);
  useEffect(() => {
    if (returnFocus.current && !view.confirming && view.address === null) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [view]);
  const copy = async () => {
    if (view.address === null) return;
    // Cleared first so a second copy changes the status text again and is announced again.
    setCopied(null);
    try {
      await navigator.clipboard.writeText(view.address);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };
  const run = () => {
    dispatch({ type: 'start' });
    setCopied(null);
    make.reset();
    make.mutate(
      { id: connection.id },
      {
        onSuccess: (made) => {
          dispatch({ type: 'made', address: made.address, created: made.created });
          make.reset();
        },
      },
    );
  };
  const hide = () => {
    returnFocus.current = true;
    setCopied(null);
    make.reset();
    dispatch({ type: 'hide' });
  };
  const cancel = () => {
    returnFocus.current = true;
    make.reset();
    dispatch({ type: 'cancel' });
  };
  const hook = status.data;
  return (
    <section className="mt-3 space-y-2 rounded-md border p-3" aria-label={t('title')}>
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>
      <p className="text-xs text-subtle-foreground">{t('intro')}</p>
      {status.error && <ErrorText>{errorMessage(status.error)}</ErrorText>}
      {hook && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {hook.exists ? (
            <>
              {hook.createdAt && <li>{t('createdAt', { when: f.dateTime(hook.createdAt) })}</li>}
              {hook.rotatedAt && <li>{t('rotatedAt', { when: f.dateTime(hook.rotatedAt) })}</li>}
              <li>{hook.lastSeenAt ? t('lastSeen', { when: f.dateTime(hook.lastSeenAt) }) : t('noNotice')}</li>
              <li>{t('rejected', { count: hook.rejectedCount })}</li>
            </>
          ) : (
            <li>{t('none')}</li>
          )}
        </ul>
      )}
      {hook?.stopped && (
        <p className="text-xs text-warning" role="alert">
          {t('stopped')}
        </p>
      )}
      {/* Always drawn, empty until the address appears, so a screen reader announces its arrival. */}
      <p className="text-xs text-foreground" role="status">
        {view.address !== null ? t('shownOnce') : ''}
      </p>
      {view.address !== null && <PushHookAddressBox address={view.address} replaced={view.replaced} inputRef={inputRef} onCopy={() => void copy()} onHide={hide} />}
      <p className="text-xs text-subtle-foreground" role="status">
        {copied === 'yes' ? t('copied') : copied === 'failed' ? t('copyFailed') : ''}
      </p>
      {view.confirming ? (
        <div className="space-y-2">
          <p className="text-xs text-warning" role="alert">
            {t('warnRotate')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmRef} loading={make.isPending} type="button" variant="outline" className="min-h-11" onClick={run}>
              {t('confirmRotate')}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" disabled={make.isPending} onClick={cancel}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        hook && (
          <Button ref={triggerRef} loading={make.isPending} type="button" variant="outline" className="min-h-11" onClick={() => (hook.exists ? dispatch({ type: 'ask' }) : run())}>
            {hook.exists ? t('rotate') : t('create')}
          </Button>
        )
      )}
      {make.error && (
        <ErrorText>
          {errorMessage(make.error)}
          {hook?.exists ? ` ${t('rotateFailed')}` : ''}
        </ErrorText>
      )}
    </section>
  );
}
