// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates an organization writes (#3578, part 3): the settings card of an owner or admin. A template is a name and 1 to 8 sections, each a title and a hint for Vy; the keys
// are code's, made by the kernel. Archive only: an archived template is listed read only and a meeting that used it keeps its own copy. The card says in one line that a template is
// layout, not a place for names or personal details, because every member reads the active ones and Vy reads the hints.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { SECTIONS_MAX, SECTION_HINT_MAX, SECTION_TITLE_MAX, TEMPLATES_ACTIVE_MAX, TEMPLATE_NAME_MAX, type MinutesTemplateView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Textarea } from '@crove/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, RowsSkeleton } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.template.key() });
};

interface DraftSection {
  // Present for a section the template already has (it keeps its key), absent for a new one.
  key?: string;
  title: string;
  hint: string;
}

function TemplateForm({
  template,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  template: MinutesTemplateView | null;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (name: string, sections: DraftSection[]) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('minutesTemplates');
  const [name, setName] = useState(template?.name ?? '');
  const [sections, setSections] = useState<DraftSection[]>(template ? template.sections.map((s) => ({ key: s.key, title: s.title, hint: s.hint })) : [{ title: '', hint: '' }]);
  const change = (i: number, patch: Partial<DraftSection>) => setSections((all) => all.map((s, at) => (at === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) =>
    setSections((all) => {
      const j = i + by;
      if (j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j] as DraftSection, next[i] as DraftSection];
      return next;
    });
  const ready = name.trim() !== '' && sections.length > 0 && sections.every((s) => s.title.trim() !== '');
  return (
    <form
      className="mt-3 space-y-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(name, sections);
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`mt-name-${template?.id ?? 'new'}`} className="text-xs font-medium">
          {t('name')}
        </label>
        <Input id={`mt-name-${template?.id ?? 'new'}`} value={name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} />
      </div>
      <p className="text-xs font-medium text-muted-foreground" data-testid="minutes-template-privacy">
        {t('noPersonalData')}
      </p>
      <ol className="space-y-3">
        {sections.map((s, i) => (
          <li key={s.key ?? `new-${i}`} className="space-y-1 rounded border p-2" data-testid="minutes-template-section">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`mt-title-${template?.id ?? 'new'}-${i}`} className="text-xs font-medium">
                {t('sectionTitle', { n: String(i + 1) })}
              </label>
              <div className="flex gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={i === 0} aria-label={t('moveUp', { n: String(i + 1) })} onClick={() => move(i, -1)}>
                  &uarr;
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={i === sections.length - 1} aria-label={t('moveDown', { n: String(i + 1) })} onClick={() => move(i, 1)}>
                  &darr;
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={sections.length === 1} aria-label={t('removeSectionN', { n: String(i + 1) })} onClick={() => setSections((all) => all.filter((_, at) => at !== i))}>
                  {t('removeSection')}
                </Button>
              </div>
            </div>
            <Input id={`mt-title-${template?.id ?? 'new'}-${i}`} value={s.title} maxLength={SECTION_TITLE_MAX} onChange={(e) => change(i, { title: e.target.value })} />
            <label htmlFor={`mt-hint-${template?.id ?? 'new'}-${i}`} className="text-xs font-medium text-muted-foreground">
              {t('sectionHint')}
            </label>
            <Textarea id={`mt-hint-${template?.id ?? 'new'}-${i}`} value={s.hint} maxLength={SECTION_HINT_MAX} rows={2} onChange={(e) => change(i, { hint: e.target.value })} />
          </li>
        ))}
      </ol>
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={sections.length >= SECTIONS_MAX} onClick={() => setSections((all) => [...all, { title: '', hint: '' }])}>
          {t('addSection')}
        </Button>
        <Button type="submit" size="sm" loading={pending} disabled={!ready}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function TemplateRow({ template }: { template: MinutesTemplateView }) {
  const t = useTranslations('minutesTemplates');
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    mutationFn: (v: { name: string; sections: DraftSection[] }) => orpc.meetings.template.update.call({ templateId: template.id, name: v.name, sections: v.sections }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const archive = useMutation({ mutationFn: () => orpc.meetings.template.archive.call({ templateId: template.id }), onSuccess: refresh });
  return (
    <li className="py-3" data-testid="minutes-template">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {/* React renders the name as text: markup typed into it is shown as typed. */}
          <p className="text-sm font-medium">{template.name}</p>
          <p className="text-xs text-muted-foreground">{t('sectionCount', { count: template.sections.length })}</p>
        </div>
        {template.archived ? (
          <Badge variant="outline">{t('archived')}</Badge>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
              {t('edit')}
            </Button>
            <ConfirmDialog
              render={
                <Button size="sm" variant="outline">
                  {t('archive')}
                </Button>
              }
              title={t('archiveTitle')}
              description={t('archiveDescription')}
              confirm={t('archiveConfirm')}
              destructive
              onConfirm={() => archive.mutate()}
            />
          </div>
        )}
      </div>
      {!editing && (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
          {template.sections.map((s) => (
            <li key={s.key}>{s.title}</li>
          ))}
        </ol>
      )}
      {archive.error ? <ErrorText>{errorMessage(archive.error)}</ErrorText> : null}
      {editing && !template.archived && (
        <TemplateForm
          template={template}
          submitLabel={t('save')}
          pending={update.isPending}
          error={update.error}
          onSubmit={(name, sections) => update.mutate({ name, sections })}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function NewTemplate({ activeCount }: { activeCount: number }) {
  const t = useTranslations('minutesTemplates');
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  const create = useMutation({
    mutationFn: (v: { name: string; sections: DraftSection[] }) => orpc.meetings.template.create.call({ name: v.name, sections: v.sections.map(({ title, hint }) => ({ title, hint })) }),
    onSuccess: () => {
      setOpen(false);
      setRound((r) => r + 1);
      refresh();
    },
  });
  if (activeCount >= TEMPLATES_ACTIVE_MAX) return <p className="mt-3 text-xs text-muted-foreground">{t('limit', { max: String(TEMPLATES_ACTIVE_MAX) })}</p>;
  if (!open)
    return (
      <Button className="mt-3" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('create')}
      </Button>
    );
  return (
    <TemplateForm
      key={round}
      template={null}
      submitLabel={t('createSubmit')}
      pending={create.isPending}
      error={create.error}
      onSubmit={(name, sections) => create.mutate({ name, sections })}
      onCancel={() => setOpen(false)}
    />
  );
}

// Owners and admins only: the commands are theirs (meetings.template.create, update, archive); every member reads the active templates in the meeting's picker.
export function MinutesTemplatesCard() {
  const t = useTranslations('minutesTemplates');
  const list = useQuery(orpc.meetings.template.list.queryOptions({ input: {} }));
  const templates = list.data?.templates ?? [];
  return (
    <Card className="block p-4" aria-label={t('title')} data-testid="minutes-templates-card">
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      <p className="mt-1 text-sm font-medium">{t('noPersonalData')}</p>
      {list.isLoading ? (
        <RowsSkeleton />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : (
        <>
          {templates.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {templates.map((tpl) => (
                <TemplateRow key={`${tpl.id}:${tpl.updatedAt}`} template={tpl} />
              ))}
            </ul>
          )}
          <NewTemplate activeCount={templates.filter((x) => !x.archived).length} />
        </>
      )}
    </Card>
  );
}
