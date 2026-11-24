// SPDX-License-Identifier: AGPL-3.0-only
// Offline dependency-free SVG QR modal for mobile finger-signing and counter handoff (#4720).
// Renders strictly in browser memory via qr-svg.ts (zero external requests, zero query tokens, zero logs).
import { useEffect, useId, useState, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Button } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { safeQrSvgPath } from '../../lib/qr-svg.ts';
import { copyTextToClipboard } from '../../lib/sign-hash.ts';
import { toast } from '../../lib/toast.ts';

export const SIGN_QR_QUIET_ZONE = 4;

export interface SignQrModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  url: string;
  signerName?: string | undefined;
  inPerson?: boolean | undefined;
  statusNotice?: string | undefined;
  triggerRef?: RefObject<HTMLElement | null> | undefined;
  testId?: string | undefined;
}

export function SignQrModal({
  open,
  onOpenChange,
  title,
  description,
  url,
  signerName,
  inPerson = false,
  statusNotice,
  triggerRef,
  testId = 'sign-qr-modal',
}: SignQrModalProps) {
  const t = useTranslations('sign.qrHandoff');
  const common = useTranslations('common');
  const inputId = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [open, url]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen && triggerRef?.current?.isConnected) {
      const target = triggerRef.current;
      window.setTimeout(() => {
        if (target.isConnected) target.focus();
      }, 0);
    }
  };

  if (!open) return null;

  const qr = safeQrSvgPath(url, SIGN_QR_QUIET_ZONE);

  const handleCopy = async () => {
    if (!url) return;
    if (await copyTextToClipboard(url)) {
      setCopied(true);
      toast(t('copiedToast'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        closeLabel={common('close')}
        finalFocus={triggerRef}
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-3">
          {signerName ? (
            <p className="text-xs font-medium text-foreground" data-testid={`${testId}-signer`}>
              {t('signerLabel', { name: signerName })}
            </p>
          ) : null}

          {inPerson ? (
            <Alert data-testid={`${testId}-in-person-note`}>
              <AlertDescription>{t('inPersonNotice')}</AlertDescription>
            </Alert>
          ) : null}

          {qr.ok ? (
            <div className="flex flex-col items-center gap-2">
              <div
                className="mx-auto flex w-fit items-center justify-center rounded-xl border border-border bg-image-surface p-3 text-foreground dark:text-background"
                data-testid={`${testId}-svg-wrap`}
              >
                <svg
                  viewBox={qr.viewBox}
                  className="h-52 w-52 max-sm:h-56 max-sm:w-56"
                  role="img"
                  aria-label={t('qrImageAria', { title })}
                  shapeRendering="crispEdges"
                  data-testid={`${testId}-svg`}
                >
                  <path d={qr.d} fill="currentColor" />
                </svg>
              </div>
              <p className="text-center text-xs text-muted-foreground">{t('scanHint')}</p>
            </div>
          ) : (
            <Alert data-testid={`${testId}-fallback`}>
              <AlertDescription>
                {qr.reason === 'too_long'
                  ? t('tooLongFallback', { bytes: String(qr.byteLength), max: String(qr.maxBytes) })
                  : t('unavailableFallback')}
              </AlertDescription>
            </Alert>
          )}

          {statusNotice ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" role="status" data-testid={`${testId}-status`}>
              {statusNotice}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={inputId} className="text-xs">
              {t('linkLabel')}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id={inputId}
                readOnly
                value={url}
                className="min-h-11 min-w-0 flex-1 font-mono text-xs"
                data-testid={`${testId}-url-input`}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                disabled={!url}
                onClick={() => void handleCopy()}
                data-testid={`${testId}-copy-btn`}
              >
                {copied ? t('copiedButton') : t('copyButton')}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => handleOpenChange(false)}
            data-testid={`${testId}-close-btn`}
          >
            {common('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
