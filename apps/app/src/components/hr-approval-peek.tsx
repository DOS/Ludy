// SPDX-License-Identifier: AGPL-3.0-only
// Shared J/K Peek Sheet layout for HR approval queues (#4645).
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ErrorText, PeekSheet } from './ui.tsx';
import type { ListPeekNav } from '../lib/list-peek-nav.ts';

export interface HrPeekAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive';
  testId?: string;
}

export interface HrPeekField {
  label: string;
  value: ReactNode;
  mono?: boolean;
  span2?: boolean;
}

export interface HrApprovalPeekSheetProps<T> {
  peek: ListPeekNav<T>;
  testId: string;
  title: string;
  description?: string | null;
  badges?: ReactNode;
  fields: readonly HrPeekField[];
  extraContent?: ReactNode;
  noteSection?: {
    id: string;
    value: string;
    placeholder: string;
    onChange: (next: string) => void;
    testId?: string;
  } | null;
  errorMessage?: string | null;
  actions: readonly HrPeekAction[];
}

export function HrApprovalPeekSheet<T>({
  peek,
  testId,
  title,
  description,
  badges,
  fields,
  extraContent,
  noteSection,
  errorMessage,
  actions,
}: HrApprovalPeekSheetProps<T>) {
  const th = useTranslations('hrEmployees');
  const common = useTranslations('common');

  return (
    <PeekSheet
      open={peek.open}
      onClose={peek.closePeek}
      peekId={peek.peekId}
      data-testid={testId}
      title={title}
      description={description}
      badges={badges}
      positionLabel={common('peek.position', {
        index: String(peek.activeIndex + 1),
        total: String(peek.total),
      })}
      canPrevious={peek.canPrevious}
      canNext={peek.canNext}
      onPrevious={() => peek.step(-1)}
      onNext={() => peek.step(1)}
      actions={
        actions.length > 0 ? (
          <>
            {actions.map((action) => (
              <Button
                key={action.testId ?? action.label}
                type="button"
                size="sm"
                variant={action.variant ?? 'default'}
                loading={action.loading ?? false}
                disabled={action.disabled ?? false}
                onClick={action.onClick}
                data-testid={action.testId}
              >
                {action.label}
              </Button>
            ))}
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {errorMessage ? <ErrorText>{errorMessage}</ErrorText> : null}

        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{th('peek.details')}</h3>
          <dl className="grid gap-2 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.label} className={field.span2 ? 'sm:col-span-2' : undefined}>
                <dt className="text-subtle-foreground">{field.label}</dt>
                <dd className={field.mono ? 'font-mono tabular-nums text-foreground' : 'text-foreground'}>
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {extraContent}

        {noteSection ? (
          <div className="space-y-1.5">
            <Label htmlFor={noteSection.id} className="text-xs font-medium text-foreground">
              {th('peek.decisionNote')}
            </Label>
            <Input
              id={noteSection.id}
              className="max-md:min-h-11"
              value={noteSection.value}
              placeholder={noteSection.placeholder}
              onChange={(event) => noteSection.onChange(event.target.value)}
              data-testid={noteSection.testId}
            />
          </div>
        ) : null}

        <p className="text-xs text-subtle-foreground">{th('peek.humanApprovalHint')}</p>
      </div>
    </PeekSheet>
  );
}
