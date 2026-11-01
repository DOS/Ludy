// SPDX-License-Identifier: AGPL-3.0-only
// The pipeline's stages for owners and admins (#2226, docs/plan/crm.md step K2): rename any stage, add, move up or down
// and remove the open ones. Won and Lost stay last and cannot be removed. A stage that still holds deals cannot be
// removed; the server says so and the message shows here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { PIPELINE_STAGE_MAX, PIPELINE_STAGE_NAME_MAX, type PipelineStage } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, Field } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { refreshDeals } from './deal-form.tsx';

const stagesKey = () => orpc.crm.pipeline.stages.queryKey({ input: {} });

function StageRow({ stage, index, open, onChange, onError }: { stage: PipelineStage; index: number; open: readonly PipelineStage[]; onChange: (stages: PipelineStage[]) => void; onError: (error: unknown) => void }) {
  const t = useTranslations('deals.pipeline');
  const [name, setName] = useState(stage.name);
  const done = { onSuccess: onChange, onError };
  const rename = useMutation(orpc.crm.pipeline.renameStage.mutationOptions(done));
  const reorder = useMutation(orpc.crm.pipeline.reorderStages.mutationOptions(done));
  const remove = useMutation(orpc.crm.pipeline.removeStage.mutationOptions(done));
  const isOpen = stage.kind === 'open';
  const shift = (by: -1 | 1) => {
    const ids = open.map((s) => s.id);
    const at = ids.indexOf(stage.id);
    const to = at + by;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to]!, ids[at]!];
    reorder.mutate({ stageIds: ids });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== stage.name) rename.mutate({ stageId: stage.id, name: name.trim() });
  };
  const at = open.findIndex((s) => s.id === stage.id);
  return (
    <li className="flex flex-wrap items-end gap-2" data-testid="stage-row">
      <form onSubmit={submit} className="flex items-end gap-2">
        <Field label={t(stage.kind === 'open' ? 'stageN' : stage.kind === 'won' ? 'won' : 'lost', { n: String(index + 1) })}>
          {(c) => <Input {...c} maxLength={PIPELINE_STAGE_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button type="submit" size="sm" variant="outline" loading={rename.isPending} disabled={!name.trim() || name.trim() === stage.name}>
          {t('rename')}
        </Button>
      </form>
      {isOpen && (
        <>
          <Button type="button" size="sm" variant="ghost" disabled={at <= 0 || reorder.isPending} aria-label={t('moveUp', { name: stage.name })} onClick={() => shift(-1)}>
            ↑
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={at >= open.length - 1 || reorder.isPending} aria-label={t('moveDown', { name: stage.name })} onClick={() => shift(1)}>
            ↓
          </Button>
          <ConfirmDialog
            render={
              <Button type="button" size="sm" variant="outline" disabled={open.length <= 1}>
                {t('remove')}
              </Button>
            }
            title={t('removeTitle')}
            description={t('removeDescription', { name: stage.name })}
            confirm={t('removeYes')}
            destructive
            onConfirm={() => remove.mutate({ stageId: stage.id })}
          >
            {t('remove')}
          </ConfirmDialog>
        </>
      )}
    </li>
  );
}

export function PipelineSettings() {
  const t = useTranslations('deals.pipeline');
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const changed = (next: PipelineStage[]) => {
    setFailure(null);
    queryClient.setQueryData(stagesKey(), next);
    refreshDeals();
  };
  const add = useMutation(
    orpc.crm.pipeline.addStage.mutationOptions({
      onSuccess: (next) => {
        setName('');
        changed(next);
      },
      onError: setFailure,
    }),
  );
  const list = stages.data ?? [];
  const open = list.filter((s) => s.kind === 'open');
  return (
    <section aria-label={t('title')} className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('hint', { max: String(PIPELINE_STAGE_MAX) })}</p>
      </div>
      <ul className="space-y-3">
        {list.map((s, i) => (
          <StageRow key={`${s.id}-${s.name}-${s.position}`} stage={s} index={i} open={open} onChange={changed} onError={setFailure} />
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate({ name: name.trim() });
        }}
      >
        <Field label={t('addLabel')}>{(c) => <Input {...c} maxLength={PIPELINE_STAGE_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Button type="submit" size="sm" loading={add.isPending} disabled={!name.trim() || list.length >= PIPELINE_STAGE_MAX}>
          {t('add')}
        </Button>
      </form>
      {failure !== null && <ErrorText>{errorMessage(failure)}</ErrorText>}
    </section>
  );
}
