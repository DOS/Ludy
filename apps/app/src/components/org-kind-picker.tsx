// SPDX-License-Identifier: AGPL-3.0-only
// The one question a new org answers when it is created (ADR-0053 amendment of 2026-11-25, #4802): is the company one person ("Một mình tôi", only
// Tài chính, Cộng tác and Ludy AI on) or does it have staff ("Có nhân viên", every app on). Two native radios in a fieldset, so the arrow keys, the
// group's name and the focus ring come from the browser; each row is at least 44 px high. The choice is not a setting: Settings, Ứng dụng & Phân hệ
// switches any app later.
import { useTranslations } from 'use-intl';
import type { OrgKind } from '@ludy/kernel-contract';

export const DEFAULT_ORG_KIND: OrgKind = 'solo';

const OPTIONS: readonly { kind: OrgKind; label: 'kindSolo' | 'kindTeam'; hint: 'kindSoloHint' | 'kindTeamHint' }[] = [
  { kind: 'solo', label: 'kindSolo', hint: 'kindSoloHint' },
  { kind: 'team', label: 'kindTeam', hint: 'kindTeamHint' },
];

export function OrgKindPicker({ value, onChange }: { value: OrgKind; onChange: (kind: OrgKind) => void }) {
  const t = useTranslations('onboarding');
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm text-muted-foreground">{t('kindLegend')}</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.kind}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input
            type="radio"
            name="onboarding-kind"
            value={option.kind}
            checked={value === option.kind}
            onChange={() => onChange(option.kind)}
            className="mt-1 size-4 shrink-0 accent-primary"
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{t(option.label)}</span>
            <span className="text-xs text-muted-foreground">{t(option.hint)}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">{t('kindLater')}</p>
    </fieldset>
  );
}
