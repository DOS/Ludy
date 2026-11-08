// SPDX-License-Identifier: AGPL-3.0-only
// "Mẫu file lương", the saved layouts of the banks' bulk-salary files in the HR app (#2893, payroll plan 6.4 and 10 row 4, ADR-0046): an owner or admin sets a bank's columns, their order, their
// headers and the payment's content text once; the export applies the template they pick. A template holds no person's data. Ludy writes a file and never initiates a payment. Owners and admins only:
// the server, the database's policies and the menu all say so. No AI in this screen; it works the same with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { HR_BANK_CONTENT_MAX, HR_BANK_HEADER_MAX, HR_BANK_NAME_MAX, type HrBankTemplate } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { blankTemplateForm, formOfTemplate, moveColumn, templateInput, templateProblems, type TemplateForm } from '../lib/bank-template.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.payroll.bankTemplates.key() });

function TemplateEditor({ template, onClose }: { template: HrBankTemplate | null; onClose: () => void }) {
  const t = useTranslations('hrBankTemplates');
  const [form, setForm] = useState<TemplateForm>(() => (template ? formOfTemplate(template) : blankTemplateForm()));
  const problems = templateProblems(form);
  const save = useMutation({
    mutationFn: () => {
      const input = templateInput(form);
      return template ? client.hr.payroll.bankTemplates.edit({ templateId: template.id, ...input }) : client.hr.payroll.bankTemplates.create(input);
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const setHeader = (index: number, header: string) => setForm((s) => ({ ...s, columns: s.columns.map((c, i) => (i === index ? { ...c, header } : c)) }));
  return (
    <Card className="mb-6 block p-4" aria-label={t('formTitle')} data-testid="hr-bank-template-form">
      <h2 className="text-base font-medium text-foreground">{template ? t('editTitle') : t('newTitle')}</h2>
      <div className="mt-3 space-y-1">
        <Label htmlFor="hr-bank-name">{t('name')}</Label>
        <Input id="hr-bank-name" value={form.name} maxLength={HR_BANK_NAME_MAX} aria-invalid={problems.has('name')} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} data-testid="hr-bank-name" />
      </div>
      <fieldset className="mt-4 space-y-2">
        <legend className="text-sm font-medium text-foreground">{t('columns')}</legend>
        <p className="text-xs text-subtle-foreground">{t('columnsHint')}</p>
        {form.columns.map((c, index) => (
          <div key={c.key} className="grid items-end gap-2 sm:grid-cols-[10rem_1fr_auto]" data-testid="hr-bank-column">
            <span className="text-sm text-foreground">{t(`columnNames.${c.key}`)}</span>
            <div className="space-y-1">
              <Label htmlFor={`hr-bank-header-${c.key}`} className="sr-only">
                {t('header', { column: t(`columnNames.${c.key}`) })}
              </Label>
              <Input id={`hr-bank-header-${c.key}`} value={c.header} maxLength={HR_BANK_HEADER_MAX} aria-invalid={problems.has(`header:${c.key}`)} onChange={(e) => setHeader(index, e.target.value)} />
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="outline" size="sm" disabled={index === 0} aria-label={t('up', { column: t(`columnNames.${c.key}`) })} onClick={() => setForm((s) => ({ ...s, columns: moveColumn(s.columns, index, -1) }))}>
                {t('upShort')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={index === form.columns.length - 1} aria-label={t('down', { column: t(`columnNames.${c.key}`) })} onClick={() => setForm((s) => ({ ...s, columns: moveColumn(s.columns, index, 1) }))}>
                {t('downShort')}
              </Button>
            </div>
          </div>
        ))}
      </fieldset>
      <div className="mt-4 space-y-1">
        <Label htmlFor="hr-bank-content">{t('content')}</Label>
        <Input id="hr-bank-content" value={form.content} maxLength={HR_BANK_CONTENT_MAX} aria-invalid={problems.has('content')} onChange={(e) => setForm((s) => ({ ...s, content: e.target.value }))} data-testid="hr-bank-content" />
        <p className="text-xs text-subtle-foreground">{t('contentHint', { token: '{month}' })}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button loading={save.isPending} disabled={problems.size > 0 || save.isPending} onClick={() => save.mutate()} data-testid="hr-bank-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </div>
    </Card>
  );
}

export function HrBankTemplatesPage() {
  const t = useTranslations('hrBankTemplates');
  const list = useQuery(orpc.hr.payroll.bankTemplates.list.queryOptions({ input: {} }));
  // A template being edited, or a new one: the editor is keyed so each opens fresh.
  const [editing, setEditing] = useState<{ template: HrBankTemplate | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (templateId: string) => client.hr.payroll.bankTemplates.delete({ templateId }),
    onSuccess: async () => {
      setConfirming(null);
      await refresh();
    },
  });
  const rows = list.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button disabled={editing !== null} onClick={() => setEditing({ template: null })} data-testid="hr-bank-new">
            {t('new')}
          </Button>
        }
      />
      {editing && <TemplateEditor key={editing.template?.id ?? 'new'} template={editing.template} onClose={() => setEditing(null)} />}
      {list.isPending ? (
        <TableSkeleton columns={4} />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('name'), t('order'), t('content'), '']}>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid="hr-bank-row">
              <TableCell className="px-4 py-3">{r.name}</TableCell>
              <TableCell className="px-4 py-3 text-sm text-muted-foreground">{r.layout.columns.map((c) => c.header).join(' / ')}</TableCell>
              <TableCell className="px-4 py-3 text-sm text-muted-foreground">{r.layout.content}</TableCell>
              <TableCell className="px-4 py-3 text-right">
                {confirming === r.id ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-xs text-foreground">{t('deleteConfirm', { name: r.name })}</span>
                    <Button variant="destructive" size="sm" loading={remove.isPending} onClick={() => remove.mutate(r.id)} data-testid="hr-bank-delete-confirm">
                      {t('delete')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                      {t('cancel')}
                    </Button>
                  </span>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ template: r })} data-testid="hr-bank-edit">
                      {t('edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(r.id)} data-testid="hr-bank-delete">
                      {t('delete')}
                    </Button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </>
  );
}
