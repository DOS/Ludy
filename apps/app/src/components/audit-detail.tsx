// SPDX-License-Identifier: AGPL-3.0-only
// The technical side of one activity log row (#3595): the command's name, the object's type and id and the detail line the
// system recorded, in a side sheet (DESIGN.md 4.5) behind the row's "Chi tiết" button. The list itself speaks in
// sentences; whoever needs the raw record (an accountant, an engineer, support) opens this.
import { useTranslations } from 'use-intl';
import type { AuditEntry } from '@ludy/kernel-contract';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { useFormat } from '../i18n/provider.tsx';

export function AuditDetailBody({ row, sentence, actor, objectName }: { row: AuditEntry; sentence: string; actor: string; objectName: string | null }) {
  const t = useTranslations('audit.detail');
  const outcomes = useTranslations('audit.outcomes');
  const f = useFormat();
  const items: [string, string | null, boolean][] = [
    [t('at'), f.dateTime(row.at), false],
    [t('actor'), actor, false],
    [t('outcome'), outcomes(row.outcome), false],
    [t('command'), row.command, true],
    [t('objectType'), objectName ?? row.targetType, row.targetType !== null && objectName === null],
    [t('objectId'), row.targetId, true],
    [t('proposalId'), row.proposalId, true],
    [t('record'), row.detail, true],
  ];
  return (
    <SheetBody>
      <p className="mb-4 text-sm text-foreground">{sentence}</p>
      <dl className="space-y-3 text-sm">
        {items
          .filter(([, value]) => value !== null && value !== '')
          .map(([label, value, mono]) => (
            <div key={label}>
              <dt className="text-xs text-subtle-foreground">{label}</dt>
              <dd className={mono ? 'font-mono text-xs break-all text-muted-foreground' : 'text-foreground'}>{value}</dd>
            </div>
          ))}
      </dl>
    </SheetBody>
  );
}

export function AuditDetail({ row, sentence, actor, objectName, onClose }: { row: AuditEntry; sentence: string; actor: string; objectName: string | null; onClose: () => void }) {
  const t = useTranslations('audit.detail');
  const common = useTranslations('common');
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent closeLabel={common('close')} data-testid="audit-detail">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('hint')}</SheetDescription>
        </SheetHeader>
        <AuditDetailBody row={row} sentence={sentence} actor={actor} objectName={objectName} />
      </SheetContent>
    </Sheet>
  );
}
