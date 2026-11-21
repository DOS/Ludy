// SPDX-License-Identifier: AGPL-3.0-only
// Offline client-side Web Crypto SHA-256 PDF verifier (/o/$slug/sign/verify): zero file bytes ever leave the browser (#3325).
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription, AlertTitle } from '@ludy/ui/components/alert';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { publicSignApi } from '../lib/sign-api.ts';
import { copyTextToClipboard, hashFileSha256 } from '../lib/sign-hash.ts';
import { toast } from '../lib/toast.ts';
import { useFormat } from '../i18n/provider.tsx';
import { ErrorText, PageHeader } from '../components/ui.tsx';

interface ParsedCertificateJson {
  certificateCode?: string;
  envelopeTitle?: string;
  sealedSha256?: string;
  sourceSha256?: string;
  completedAt?: string;
}

export interface VerifyVerdict {
  matched: boolean;
  title?: string;
  certificateCode?: string;
  expectedSha256?: string;
  completedAt?: string;
  signerCount?: number;
}

export function extractCertificateJsonFields(rawText: string): ParsedCertificateJson | null {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const files = (parsed.files ?? {}) as Record<string, unknown>;
    const envelope = (parsed.envelope ?? {}) as Record<string, unknown>;
    const sealedSha256 =
      typeof parsed.sealedSha256 === 'string'
        ? parsed.sealedSha256
        : typeof files.sealedSha256 === 'string'
          ? files.sealedSha256
          : undefined;
    const sourceSha256 =
      typeof parsed.sourceSha256 === 'string'
        ? parsed.sourceSha256
        : typeof files.sourceSha256 === 'string'
          ? files.sourceSha256
          : undefined;
    const certificateCode =
      typeof parsed.certificateCode === 'string'
        ? parsed.certificateCode
        : typeof envelope.certificateCode === 'string'
          ? envelope.certificateCode
          : typeof files.certificateCode === 'string'
            ? files.certificateCode
            : undefined;
    const envelopeTitle =
      typeof parsed.envelopeTitle === 'string'
        ? parsed.envelopeTitle
        : typeof envelope.title === 'string'
          ? envelope.title
          : undefined;
    if (!sealedSha256 && !sourceSha256) return null;
    return {
      ...(sealedSha256 ? { sealedSha256: sealedSha256.toLowerCase() } : {}),
      ...(sourceSha256 ? { sourceSha256: sourceSha256.toLowerCase() } : {}),
      ...(certificateCode ? { certificateCode } : {}),
      ...(envelopeTitle ? { envelopeTitle } : {}),
    };
  } catch {
    return null;
  }
}

export function SignVerifyPage() {
  const t = useTranslations('sign.verify');
  const tEvidence = useTranslations('sign.evidence');
  const f = useFormat();

  const [fileName, setFileName] = useState<string | null>(null);
  const [computedSha256, setComputedSha256] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [certificateCode, setCertificateCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<VerifyVerdict | null>(null);
  const pickGenerationRef = useRef(0);

  const handlePdfPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const gen = ++pickGenerationRef.current;
    setError(null);
    setVerdict(null);
    setComputedSha256(null);
    setChecking(false);
    const file = event.target.files?.[0];
    if (!file) {
      setFileName(null);
      setComputing(false);
      return;
    }
    setFileName(file.name);
    setComputing(true);
    try {
      const digest = await hashFileSha256(file);
      if (pickGenerationRef.current !== gen) return;
      setComputedSha256(digest);
    } catch (err) {
      if (pickGenerationRef.current !== gen) return;
      setError(err instanceof Error ? err.message : 'HASH_FAILED');
    } finally {
      if (pickGenerationRef.current === gen) {
        setComputing(false);
      }
    }
  };

  const handleCertificateJsonPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const gen = pickGenerationRef.current;
    setError(null);
    setVerdict(null);
    const file = event.target.files?.[0];
    if (!file || !computedSha256) return;
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      if (pickGenerationRef.current === gen) {
        setError(t('invalidCertJson'));
      }
      return;
    }
    if (pickGenerationRef.current !== gen) return;
    const parsed = extractCertificateJsonFields(raw);
    if (!parsed) {
      setError(t('invalidCertJson'));
      return;
    }
    if (parsed.certificateCode) setCertificateCode(parsed.certificateCode);
    const expected = parsed.sealedSha256 ?? parsed.sourceSha256;
    const matched = expected === computedSha256.toLowerCase();
    setVerdict({
      matched,
      ...(parsed.envelopeTitle ? { title: parsed.envelopeTitle } : {}),
      ...(parsed.certificateCode ? { certificateCode: parsed.certificateCode } : {}),
      ...(expected ? { expectedSha256: expected } : {}),
    });
  };

  const handleServerCheck = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!computedSha256) return;
    const gen = pickGenerationRef.current;
    setError(null);
    setVerdict(null);
    setChecking(true);
    try {
      const cleanCode = certificateCode.trim().toUpperCase();
      const res = await publicSignApi.verifyPublic({
        certificateCode: cleanCode,
        fileSha256: computedSha256,
      });
      if (pickGenerationRef.current !== gen) return;
      setVerdict({
        matched: res.matched,
        ...(res.envelopeTitle ? { title: res.envelopeTitle } : {}),
        ...(res.certificateCode ? { certificateCode: res.certificateCode } : { certificateCode: cleanCode }),
        ...(res.sealedSha256 ? { expectedSha256: res.sealedSha256 } : {}),
        ...(res.completedAt ? { completedAt: res.completedAt } : {}),
        ...(typeof res.signerCount === 'number' ? { signerCount: res.signerCount } : {}),
      });
    } catch (err) {
      if (pickGenerationRef.current !== gen) return;
      setError(err instanceof Error ? err.message : 'VERIFY_FAILED');
    } finally {
      if (pickGenerationRef.current === gen) {
        setChecking(false);
      }
    }
  };

  const handleCopyDigest = async () => {
    if (!computedSha256) return;
    if (await copyTextToClipboard(computedSha256)) {
      toast(tEvidence('copiedToast'));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('pickFile')}</CardTitle>
            <CardDescription>{t('dropHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="verify-pdf-file" className="sr-only">
                {t('pickFile')}
              </Label>
              <Input
                id="verify-pdf-file"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => void handlePdfPick(e)}
                data-testid="verify-pdf-input"
              />
            </div>
            {computing ? <p className="text-xs text-muted-foreground">{t('computing')}</p> : null}
            {computedSha256 ? (
              <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3" data-testid="verify-computed-sha256">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('computedDigest')} ({fileName})
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void handleCopyDigest()}>
                    {tEvidence('copyDigest')}
                  </Button>
                </div>
                <p className="break-all font-mono text-xs text-foreground">{computedSha256}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('checkButton')}</CardTitle>
            <CardDescription>{t('offlineNote')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? <ErrorText>{error}</ErrorText> : null}

            <form onSubmit={(e) => void handleServerCheck(e)} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="verify-cert-code">{t('certificateInputLabel')}</Label>
                <Input
                  id="verify-cert-code"
                  value={certificateCode}
                  onChange={(e) => setCertificateCode(e.target.value)}
                  className="font-mono"
                  placeholder="CS-XXXX-XXXX-XXXX"
                  data-testid="verify-cert-code-input"
                />
              </div>
              <Button
                type="submit"
                disabled={!computedSha256 || !certificateCode.trim()}
                loading={checking}
                data-testid="verify-check-btn"
              >
                {t('checkButton')}
              </Button>
            </form>

            <div className="space-y-1.5 border-t pt-3">
              <Label htmlFor="verify-cert-json">{t('loadCertificateJson')}</Label>
              <Input
                id="verify-cert-json"
                type="file"
                accept="application/json,.json"
                disabled={!computedSha256}
                onChange={(e) => void handleCertificateJsonPick(e)}
                data-testid="verify-cert-json-input"
              />
            </div>

            {verdict ? (
              <Alert
                variant={verdict.matched ? 'default' : 'destructive'}
                className={verdict.matched ? 'border-success/40 bg-success/10 text-success' : 'border-destructive/40 bg-destructive/10'}
                data-testid="verify-verdict-banner"
              >
                <AlertTitle>{verdict.matched ? t('matchOk') : t('matchFail')}</AlertTitle>
                {verdict.title || verdict.certificateCode || verdict.completedAt ? (
                  <AlertDescription className="mt-1 font-mono text-xs">
                    {[
                      verdict.title,
                      verdict.certificateCode,
                      verdict.completedAt ? f.dateTime(verdict.completedAt) : null,
                    ]
                      .filter(Boolean)
                      .join(' - ')}
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
