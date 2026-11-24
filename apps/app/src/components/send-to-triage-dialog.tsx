// SPDX-License-Identifier: AGPL-3.0-only
// 1-click "Send to Triage" action button & compact confirmation dialog (#4493, ADR-0058):
// used in Inbox Conversations, Meetings, and Public Roadmap moderation panels. Pre-selects active project for SMEs.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  PROJECT_TRIAGE_DESCRIPTION_MAX,
  PROJECT_TRIAGE_PRIORITIES,
  PROJECT_TRIAGE_TITLE_MAX,
  type ProjectTriagePriority,
} from '@ludy/kernel-contract';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';
import { toast } from '../lib/toast.ts';

export type SendToTriageSourceType = 'kernel.conversation' | 'meetings.meeting' | 'roadmap.item';

/** Computes initial or fallback project selection for SendToTriageDialog without overwriting valid user choices. */
export function resolveSendDialogProjectSelection(args: {
  initializedOnOpen: boolean;
  projectId: string;
  defaultProjectId?: string | undefined;
  writableProjectIds: readonly string[];
}): { nextProjectId: string; initializedOnOpen: boolean } {
  const { initializedOnOpen, projectId, defaultProjectId, writableProjectIds } = args;
  if (writableProjectIds.length === 0) {
    return { nextProjectId: projectId, initializedOnOpen };
  }
  const isCurrentValid = projectId !== '' && writableProjectIds.includes(projectId);
  const preferredDefault =
    defaultProjectId && writableProjectIds.includes(defaultProjectId)
      ? defaultProjectId
      : (writableProjectIds[0] ?? '');

  if (!initializedOnOpen) {
    return {
      nextProjectId: defaultProjectId && writableProjectIds.includes(defaultProjectId) ? defaultProjectId : isCurrentValid ? projectId : preferredDefault,
      initializedOnOpen: true,
    };
  }
  if (!isCurrentValid) {
    return { nextProjectId: preferredDefault, initializedOnOpen: true };
  }
  return { nextProjectId: projectId, initializedOnOpen: true };
}

export function SendToTriageDialog({
  slug,
  sourceType,
  sourceId,
  defaultTitle = '',
  defaultDescription = null,
  defaultProjectId,
  canWrite = true,
  size = 'sm',
  variant = 'outline',
  buttonTestId,
}: {
  slug: string;
  sourceType: SendToTriageSourceType;
  sourceId: string;
  defaultTitle?: string;
  defaultDescription?: string | null;
  defaultProjectId?: string | undefined;
  canWrite?: boolean;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost' | 'secondary';
  buttonTestId?: string;
}) {
  const t = useTranslations('projects.triage');
  useModulesVersion();
  const projectsEnabled = installedModules().includes('projects');
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [priority, setPriority] = useState<ProjectTriagePriority>('medium');
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const initializedOnOpenRef = useRef(false);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const projectsQuery = useQuery({
    ...orpc.projects.list.queryOptions({ input: { status: ['active', 'on_hold'] } }),
    enabled: open && projectsEnabled,
    staleTime: 30_000,
  });

  const writableProjects = useMemo(
    () =>
      projectsQuery.data?.canWrite === true
        ? (projectsQuery.data.projects ?? []).filter((p) => p.status !== 'archived')
        : [],
    [projectsQuery.data],
  );

  useEffect(() => {
    setOpen(false);
    setCreatedProjectId(null);
    initializedOnOpenRef.current = false;
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [sourceId]);

  useEffect(() => {
    if (!open) {
      initializedOnOpenRef.current = false;
      return;
    }
    setTitle(defaultTitle);
    setDescription(defaultDescription ?? '');
    setPriority('medium');
    setCreatedProjectId(null);
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [open, defaultTitle, defaultDescription]);

  useEffect(() => {
    if (!open) {
      initializedOnOpenRef.current = false;
      return;
    }
    if (writableProjects.length === 0) return;
    const resolution = resolveSendDialogProjectSelection({
      initializedOnOpen: initializedOnOpenRef.current,
      projectId,
      defaultProjectId,
      writableProjectIds: writableProjects.map((p) => p.id),
    });
    initializedOnOpenRef.current = resolution.initializedOnOpen;
    if (resolution.nextProjectId !== projectId) {
      setProjectId(resolution.nextProjectId);
      idempotencyKeyRef.current = crypto.randomUUID();
    }
  }, [open, defaultProjectId, writableProjects, projectId]);

  const createMutation = useMutation(
    orpc.projects.triage.create.mutationOptions({
      onSuccess: (res) => {
        setCreatedProjectId(res.item.projectId);
        idempotencyKeyRef.current = crypto.randomUUID();
        void queryClient.invalidateQueries({ queryKey: orpc.projects.triage.key() });
        toast(t('sendDialog.sentToast'), 'success');
      },
    }),
  );

  if (!canWrite || !projectsEnabled) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || title.trim() === '') return;
    createMutation.mutate({
      projectId,
      sourceType,
      sourceId,
      priority,
      title: title.trim().slice(0, PROJECT_TRIAGE_TITLE_MAX),
      description: description.trim() ? description.trim().slice(0, PROJECT_TRIAGE_DESCRIPTION_MAX) : null,
      idempotencyKey: idempotencyKeyRef.current,
    });
  };

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className="min-h-11"
        onClick={() => setOpen(true)}
        data-testid={buttonTestId ?? `send-to-triage-${sourceType}-${sourceId}`}
      >
        {t('sendDialog.trigger')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg" closeLabel={t('common.cancel')} data-testid="send-to-triage-dialog">
          <DialogHeader>
            <DialogTitle>{t('sendDialog.title')}</DialogTitle>
            <DialogDescription>{t('sendDialog.subtitle')}</DialogDescription>
          </DialogHeader>
          {createdProjectId ? (
            <div className="space-y-4">
              <p className="text-sm text-foreground">{t('sendDialog.sentMessage')}</p>
              <DialogFooter>
                <Link
                  to="/o/$slug/projects/$id"
                  params={{ slug, id: createdProjectId }}
                  search={{ view: 'triage' } as never}
                  onClick={() => setOpen(false)}
                  className={`${buttonVariants({ size: 'sm', variant: 'outline' })} min-h-11`}
                >
                  {t('sendDialog.openTriageLink')}
                </Link>
                <DialogClose render={<Button type="button" size="sm" className="min-h-11" />}>
                  {t('common.done')}
                </DialogClose>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={`send-triage-project-${sourceId}`}>{t('sendDialog.projectLabel')}</Label>
                {projectsQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                ) : writableProjects.length === 0 ? (
                  <p className="text-sm text-destructive">{t('sendDialog.noWritableProjects')}</p>
                ) : (
                  <NativeSelect
                    id={`send-triage-project-${sourceId}`}
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      idempotencyKeyRef.current = crypto.randomUUID();
                    }}
                    className="min-h-11 [&_select]:min-h-11"
                  >
                    {writableProjects.map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        {p.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`send-triage-title-${sourceId}`}>{t('fields.titleLabel')}</Label>
                <Input
                  id={`send-triage-title-${sourceId}`}
                  required
                  maxLength={PROJECT_TRIAGE_TITLE_MAX}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    idempotencyKeyRef.current = crypto.randomUUID();
                  }}
                  placeholder={t('fields.titlePlaceholder')}
                  className="min-h-11"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`send-triage-priority-${sourceId}`}>{t('fields.priorityLabel')}</Label>
                <NativeSelect
                  id={`send-triage-priority-${sourceId}`}
                  value={priority}
                  onChange={(e) => {
                    setPriority(e.target.value as ProjectTriagePriority);
                    idempotencyKeyRef.current = crypto.randomUUID();
                  }}
                  className="min-h-11 [&_select]:min-h-11"
                >
                  {PROJECT_TRIAGE_PRIORITIES.map((p) => (
                    <NativeSelectOption key={p} value={p}>
                      {t(`priorities.${p}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`send-triage-desc-${sourceId}`}>{t('fields.descriptionLabel')}</Label>
                <Textarea
                  id={`send-triage-desc-${sourceId}`}
                  rows={3}
                  maxLength={PROJECT_TRIAGE_DESCRIPTION_MAX}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    idempotencyKeyRef.current = crypto.randomUUID();
                  }}
                  placeholder={t('fields.descriptionPlaceholder')}
                />
              </div>

              {createMutation.error && <ErrorText>{errorMessage(createMutation.error)}</ErrorText>}

              <DialogFooter>
                <DialogClose render={<Button type="button" variant="ghost" className="min-h-11" />}>
                  {t('common.cancel')}
                </DialogClose>
                <Button
                  type="submit"
                  loading={createMutation.isPending}
                  disabled={!projectId || title.trim() === '' || writableProjects.length === 0}
                  className="min-h-11"
                  data-testid="send-to-triage-submit"
                >
                  {t('sendDialog.submit')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
