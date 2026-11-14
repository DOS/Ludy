// SPDX-License-Identifier: AGPL-3.0-only
// "Cần xác nhận trước khi ghi" (Meetings A2, #3160): the org setting that narrows which consent methods a new meeting may use. Everyone who reads
// meetings sees it; an owner or admin changes it, and a change applies to meetings created afterwards. The server refuses a method a strict org does not
// accept (meetings.meeting.create), so these screens only hide the choice and say why. No AI part: the core works with AI off.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_CONSENT_POLICIES, type MeetingConsentPolicy } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { ErrorText } from './ui.tsx';

// The org's policy; 'standard' while it loads or when it cannot be read (the server decides in any case).
export function useConsentPolicy(): MeetingConsentPolicy {
  const query = useQuery(orpc.meetings.consentPolicy.get.queryOptions({ input: {} }));
  return query.data?.policy ?? 'standard';
}

export function ConsentPolicyCard() {
  const t = useTranslations('meetings.consentPolicy');
  const query = useQuery(orpc.meetings.consentPolicy.get.queryOptions({ input: {} }));
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const [draft, setDraft] = useState<MeetingConsentPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = draft ?? query.data?.policy ?? null;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await orpc.meetings.consentPolicy.set.call({ policy: draft });
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.consentPolicy.key() });
      setDraft(null);
      toast(t('saved'), 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (query.isPending || !current) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="consent-policy">{t('label')}</Label>
          <NativeSelect id="consent-policy" disabled={!canEdit} value={current} onChange={(e) => setDraft(e.target.value as MeetingConsentPolicy)}>
            {MEETING_CONSENT_POLICIES.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {t(`choice.${p}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground" data-testid="consent-policy-explain">
            {t(`explain.${current}`)}
          </p>
        </div>
        {error ? <ErrorText>{error}</ErrorText> : null}
        {canEdit ? (
          <Button onClick={() => void save()} disabled={!draft || saving}>
            {t('save')}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}
