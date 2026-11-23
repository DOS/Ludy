// SPDX-License-Identifier: AGPL-3.0-only
// The default item of a MISA connection for one kind of line (#4124, S3b of #4103), under the item code field of the preview: the code the person keeps so they need not type it with every preview. An owner or
// admin keeps what is in the field (or clears it); everyone else sees what is kept. The code is typed as the MISA catalogue spells it: it is not looked up here (the API cannot read the catalogue); the next
// check against the catalogue says when an item is not there, by line.
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { MisaAmisDefaultItem } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

/** What the buttons offer for the code in the field: keep it (it is not the kept one), clear the kept one. */
export function defaultItemOffer(typed: string, saved: string | null): { canSave: boolean; canClear: boolean } {
  const code = typed.trim();
  return { canSave: code.length > 0 && code !== saved, canClear: saved !== null };
}

export function MisaAmisDefaultItem({ connectionId, role, typed, saved, canManage }: { connectionId: string; role: MisaAmisDefaultItem['role']; typed: string; saved: string | null; canManage: boolean }) {
  const t = useTranslations('misaAmisPreview');
  const keep = useMutation<unknown, Error, string | null>({
    mutationFn: (code) => client.misaAmis.connections.setDefaultItem({ id: connectionId, role, code }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.misaAmis.connections.list.key() }),
  });
  const offer = defaultItemOffer(typed, saved);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`misa-amis-default-${role}`}>
      {/* A status region that exists before its text changes, so a screen reader announces what was kept or cleared. */}
      <span role="status" className="text-xs text-subtle-foreground" data-testid={`misa-amis-default-${role}-state`}>
        {saved === null ? t('defaultNone') : t('defaultIs', { code: saved })}
      </span>
      {/* The buttons stay where they are and are disabled when they would change nothing, so the keyboard focus a click leaves on one is not lost when it has done its work. */}
      {canManage && (
        <Button type="button" size="sm" variant="ghost" loading={keep.isPending} disabled={!offer.canSave} onClick={() => keep.mutate(typed.trim())} data-testid={`misa-amis-default-${role}-save`}>
          {t('defaultSave')}
        </Button>
      )}
      {canManage && (
        <Button type="button" size="sm" variant="ghost" loading={keep.isPending} disabled={!offer.canClear} onClick={() => keep.mutate(null)} data-testid={`misa-amis-default-${role}-clear`}>
          {t('defaultClear')}
        </Button>
      )}
      {keep.error && <ErrorText>{errorMessage(keep.error)}</ErrorText>}
    </div>
  );
}
