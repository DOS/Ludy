// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Checkbox } from '@ludy/ui/components/checkbox';
import type { LegalEntity, MemberRoles } from '@ludy/kernel-contract';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { StepUpPrompt } from '../../components/two-factor.tsx';
import { MemberRolesRow } from '../member-roles.tsx';
import { MemberPrivateNotes, usePrivateNotes } from '../../components/notes-panel.tsx';
import { MemberSessions } from '../../components/sessions.tsx';
import { FormDialog, useLive } from '../../components/form-dialog.tsx';
import { DuplicateHint } from '../../components/form-panel.tsx';
import { ErrorText, Field, focusFirstInvalid, isEmailAddress, RowsSkeleton, useFieldErrors } from '../../components/ui.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../../lib/api.ts';
import { getConfig } from '../../lib/auth.ts';
import { useFormat } from '../../i18n/provider.tsx';
import { ROLES, roleChangeConfirmation, roleChangeKind, type Role, type RoleChangeKind } from '../../lib/members.ts';
import { invitedEmailState } from '../../lib/duplicates.ts';
import { asRoleKey, inviteRoleChoices, roleHintKey } from '../../lib/member-roles.ts';
import { installedModules, useModulesVersion } from '../../lib/org-modules.ts';
import { MEMBERS_CARD_ID } from '../approval-preset.tsx';

export interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

// What waits for confirmation. It holds the change, not its words, which are made at render (issue #215).
type Pending = { kind: 'remove' } | { kind: 'role'; role: Role; reason: RoleChangeKind };

// Owner controls for one member, the owner themself included: change the role, or remove another member. Removal and
// every change that gives or takes owner rights (promotion to owner, demoting an owner, the owner's own role) wait
// for an inline confirmation (#119). The server enforces every rule (owners only, the org keeps an owner, no
// self-removal, fresh MFA); the screen only hides what can never succeed. One idempotency key per confirmation, so a
// retried request is replayed, not repeated.
export function MemberControls({ member, self }: { member: MemberRow; self: boolean }) {
  const root = useTranslations();
  const t = useTranslations('settings');
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmKey, setConfirmKey] = useState(() => crypto.randomUUID());
  const settled = () => {
    setPending(null);
    setConfirmKey(crypto.randomUUID());
    void queryClient.invalidateQueries();
  };
  const changeRole = useMutation(orpc.org.changeMemberRole.mutationOptions({ onSuccess: settled }));
  const remove = useMutation(orpc.org.removeMember.mutationOptions({ onSuccess: settled }));
  const busy = changeRole.isPending || remove.isPending;
  const name = member.displayName ?? member.email;
  const privateNotes = usePrivateNotes(member.userId);

  const ask = (next: Pending) => {
    changeRole.reset();
    remove.reset();
    setConfirmKey(crypto.randomUUID());
    setPending(next);
  };
  const pickRole = (role: Role) => {
    const reason = roleChangeKind({ from: member.role, to: role, self });
    if (reason) ask({ kind: 'role', role, reason });
    else if (role !== member.role) changeRole.mutate({ userId: member.userId, role, idempotencyKey: crypto.randomUUID() });
  };

  if (pending) {
    const text =
      pending.kind === 'remove'
        ? { title: t('removeTitle', { name }), body: t('removeBody'), action: t('confirmRemove') }
        : roleChangeConfirmation(pending.reason, { name, to: pending.role }, root);
    const confirm = () =>
      pending.kind === 'remove'
        ? remove.mutate({ userId: member.userId, idempotencyKey: confirmKey })
        : changeRole.mutate({ userId: member.userId, role: pending.role, idempotencyKey: confirmKey });
    const error = pending.kind === 'remove' ? remove.error : changeRole.error;
    return (
      <div className="max-w-xs space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={text.title}>
        <p className="font-medium text-foreground">{text.title}</p>
        <p className="text-muted-foreground">{text.body}</p>
        {/* How many private notes they leave behind (#1671, ADR-0037 §4), so the owner can ask them to share first. */}
        {pending.kind === 'remove' && <MemberPrivateNotes notes={privateNotes} />}
        <div className="flex gap-2">
          <Button variant="destructive" disabled={busy || (pending.kind === 'remove' && !privateNotes.ready)} onClick={confirm}>
            {text.action}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              changeRole.reset();
              remove.reset();
              setPending(null);
            }}
          >
            {root('common.cancel')}
          </Button>
        </div>
        {error &&
          (isStepUpRequired(error) ? (
            // R3: after a fresh second factor the confirmed request runs again with its key.
            <StepUpPrompt
              action={pending.kind === 'remove' ? t('stepUpRemove', { name }) : t('stepUpRole', { name, role: root(`roles.${pending.role}`) })}
              onVerified={confirm}
            />
          ) : (
            <ErrorText>{errorMessage(error)}</ErrorText>
          ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <NativeSelect
          size="sm"
          value={member.role}
          disabled={busy}
          onChange={(e) => pickRole(e.target.value as Role)}
          aria-label={self ? t('yourRole') : t('roleOf', { name })}
        >
          {ROLES.map((r) => (
            <NativeSelectOption key={r} value={r}>
              {root(`roles.${r}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {!self && (
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => ask({ kind: 'remove' })}>
            {t('remove')}
          </Button>
        )}
      </div>
      {changeRole.error &&
        (isStepUpRequired(changeRole.error) ? (
          // R3: after a fresh second factor the same request runs again (a refused request stores no key).
          <StepUpPrompt
            action={t('stepUpRole', { name, role: root(`roles.${changeRole.variables?.role ?? member.role}`) })}
            onVerified={() => changeRole.variables && changeRole.mutate(changeRole.variables)}
            onCancel={() => changeRole.reset()}
          />
        ) : (
          <ErrorText>{errorMessage(changeRole.error)}</ErrorText>
        ))}
    </div>
  );
}

type InviteRole = 'admin' | 'member' | 'viewer';

// The accept link is shown once, right after the invite is created: the server keeps only a hash of its token.
export function CreatedInvite({ invite, onDone }: { invite: { email: string; expiresAt: string; acceptPath: string }; onDone: () => void }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const f = useFormat();
  const link = `${window.location.origin}${invite.acceptPath}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 space-y-2 rounded-lg border bg-muted p-3 text-sm" role="status">
      <p className="text-foreground">{t('inviteCreated', { email: invite.email })}</p>
      <p className="text-muted-foreground">
        {getConfig().mailEnabled ? t('inviteMailSent') : t('inviteMailOff')} {t('inviteRules', { at: f.dateTime(invite.expiresAt) })}
      </p>
      <p className="break-all rounded border bg-card px-2 py-1 font-mono text-xs text-foreground">{link}</p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(link).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? t('copied') : t('copyLink')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {tc('close')}
        </Button>
      </div>
    </div>
  );
}

// `initialEmail`: the contact onboarding asked to invite (?invite=, issue #324). An owner of an org with more than one
// legal entity may limit the invitee to some of them (#1447, the server's #1281): an outside accountant who keeps one
// company's books. Such an invite is for a member or a viewer, never an admin.
// An owner may also pick one department role (#2611): a preset of the role catalog, granted when the invite is accepted. It does
// not go with the entity limit, which is its own preset (the outside accountant); an admin sees only that owners give it.
export function InviteMember({
  isOwner,
  initialEmail,
  entities,
  catalog,
  members = [],
}: {
  isOwner: boolean;
  initialEmail?: string | undefined;
  entities: LegalEntity[];
  catalog: MemberRoles['roles'];
  // The members, for the warning when the address typed already belongs to one (#3608).
  members?: readonly { email: string }[];
}) {
  const root = useTranslations();
  const t = useTranslations('settings');
  const [email, setEmail] = useState(initialEmail ?? '');
  // The form is a dialog opened by "Mời thành viên" (#3608); onboarding's ?invite= opens it at once with the address filled.
  const [open, setOpen] = useState(Boolean(initialEmail));
  const pendingInvites = useQuery(orpc.org.listInvites.queryOptions());
  const known = invitedEmailState(email, members, pendingInvites.data ?? []);
  const [role, setRole] = useState<InviteRole>('member');
  const [scoped, setScoped] = useState(false);
  const [departmentKey, setDepartmentKey] = useState('');
  const [entityIds, setEntityIds] = useState<string[]>([]);
  const [noEntity, setNoEntity] = useState(false);
  useModulesVersion(); // the apps of the org can change while this form is open (the Marketing hint names ads only when ads runs)
  const canScope = isOwner && entities.length > 1;
  const choices = inviteRoleChoices(catalog, role);
  // A role that cannot go with the base role picked since (a viewer) is dropped.
  const department = choices.find((r) => r.key === departmentKey);
  const scopeId = useId();
  // The email is checked on leaving the field and on submit, its error under the row (#1515); the server checks again.
  const emailId = `${scopeId}-email`;
  const fields = useFieldErrors<'email'>(() => (!email.trim() ? t('inviteEmailRequired') : isEmailAddress(email) ? null : t('inviteEmailInvalid')));
  const invite = useMutation(
    orpc.org.invite.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.org.listInvites.key() });
      },
    }),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missingEntity = scoped && entityIds.length === 0;
    setNoEntity(missingEntity);
    // checkAll shows the email's error, and the missing entity with it, before the focus moves to the first of them.
    if (!fields.checkAll(['email']) || missingEntity) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    // A member cannot be invited again; an address with an invitation waiting can: the new one replaces it (the hint says so).
    if (known === 'member') return;
    invite.mutate(scoped ? { email, role, legalEntityIds: entityIds } : department ? { email, role, roleKey: department.key } : { email, role });
  }
  const toggleEntity = (id: string, checked: boolean) => {
    setNoEntity(false);
    setEntityIds((ids) => (checked ? [...ids, id] : ids.filter((x) => x !== id)));
  };

  const live = useLive();
  const inviteButton = useRef<HTMLButtonElement>(null);
  const reset = () => {
    invite.reset();
    setOpen(false);
    setEmail('');
    setRole('member');
    setScoped(false);
    setDepartmentKey('');
    setEntityIds([]);
    setNoEntity(false);
    fields.reset();
    // The dialog that closes was not the one that opened (the form gave way to the link): focus goes back to the button by hand.
    window.setTimeout(() => inviteButton.current?.focus(), 0);
  };
  const stepUp = isStepUpRequired(invite.error);
  return (
    <>
      <div className="mt-4">
        <Button ref={inviteButton} type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('inviteTitle')}
        </Button>
      </div>
      {/* The accept link is shown once, so the result stays on screen until it is closed. */}
      {open && invite.data && (
        // Escape or the close button ends it; a click on the dimmed page does not, so the link shown once is not lost by a stray click.
        <Dialog open disablePointerDismissal onOpenChange={(next) => !next && reset()}>
          <DialogContent closeLabel={root('common.close')}>
            <DialogHeader>
              <DialogTitle>{t('inviteTitle')}</DialogTitle>
            </DialogHeader>
            <CreatedInvite invite={invite.data} onDone={reset} />
          </DialogContent>
        </Dialog>
      )}
      {open && !invite.data && (
        <FormDialog
          title={t('inviteTitle')}
          label={t('inviteTitle')}
          busy={invite.isPending}
          dirty={email !== (initialEmail ?? '') || role !== 'member' || scoped || departmentKey !== '' || entityIds.length > 0}
          submitLabel={t('invite')}
          submitDisabled={known === 'member' || stepUp}
          onClose={reset}
          onSubmit={submit}
          outside={
            stepUp ? (
              // Inviting is R3. Outside the form above: the prompt has a form of its own.
              <StepUpPrompt
                action={
                  invite.variables?.roleKey
                    ? t('stepUpInviteRole', {
                        email: invite.variables.email,
                        role: root(`roles.${invite.variables.role}`),
                        department: root(`memberRoles.roles.${invite.variables.roleKey}`),
                      })
                    : t('stepUpInvite', { email: invite.variables?.email ?? email, role: root(`roles.${invite.variables?.role ?? role}`) })
                }
                onVerified={() => live.current && invite.variables && invite.mutate(invite.variables)}
                onCancel={() => invite.reset()}
              />
            ) : null
          }
        >
          <Field id={emailId} label={t('inviteEmail')} hint={t('inviteHint')} error={fields.of('email')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                required
                maxLength={320}
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  fields.edit('email');
                }}
                onBlur={(e) => fields.blur('email', e.target.value)}
              />
            )}
          </Field>
          <DuplicateHint testId="invite-duplicate">{known ? t(known === 'member' ? 'inviteAlreadyMember' : 'inviteAlreadyInvited', { email: email.trim() }) : null}</DuplicateHint>
          <Field label={t('role')}>
            {(control) => (
              <NativeSelect {...control} value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
                {isOwner && !scoped && <NativeSelectOption value="admin">{root('roles.admin')}</NativeSelectOption>}
                <NativeSelectOption value="member">{root('roles.member')}</NativeSelectOption>
                <NativeSelectOption value="viewer">{root('roles.viewer')}</NativeSelectOption>
              </NativeSelect>
            )}
          </Field>
          {catalog.length > 0 &&
            (isOwner ? (
              <div className="space-y-1">
                <NativeSelect value={department?.key ?? ''} onChange={(e) => setDepartmentKey(e.target.value)} disabled={scoped} aria-label={t('inviteDepartment')}>
                  <NativeSelectOption value="">{t('inviteDepartmentNone')}</NativeSelectOption>
                  {choices.map((r) => (
                    <NativeSelectOption key={r.key} value={r.key}>
                      {root(`memberRoles.roles.${r.key}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {department && <p className="text-xs text-subtle-foreground">{root(`memberRoles.hints.${roleHintKey(department.key, installedModules())}`)}</p>}
                {scoped && <p className="text-xs text-subtle-foreground">{t('inviteDepartmentScoped')}</p>}
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">{t('inviteDepartmentOwnerOnly')}</p>
            ))}
          {canScope && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={scoped}
                  disabled={Boolean(department)}
                  onCheckedChange={(checked) => {
                    setScoped(checked);
                    setNoEntity(false);
                    // A scoped invite is never for an admin.
                    if (checked && role === 'admin') setRole('member');
                  }}
                />
                <span>{t('inviteScoped')}</span>
              </label>
              {scoped && (
                <fieldset
                  className="space-y-1.5 rounded-lg border p-3"
                  aria-invalid={noEntity || undefined}
                  aria-describedby={noEntity ? `${scopeId}-hint ${scopeId}-error` : `${scopeId}-hint`}>
                  <legend className="px-1 text-xs text-subtle-foreground">{t('inviteEntities')}</legend>
                  <p id={`${scopeId}-hint`} className="text-xs text-subtle-foreground">
                    {t('inviteScopedHint')}
                  </p>
                  {entities.map((e) => (
                    <label key={e.id} className="flex items-center gap-2 text-sm text-foreground">
                      <Checkbox checked={entityIds.includes(e.id)} onCheckedChange={(checked) => toggleEntity(e.id, checked)} />
                      <span>{e.name}</span>
                    </label>
                  ))}
                  {noEntity && (
                    <p id={`${scopeId}-error`} role="alert" className="text-xs text-destructive">
                      {t('inviteNoEntity')}
                    </p>
                  )}
                </fieldset>
              )}
            </div>
          )}
            {invite.error && !stepUp && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
        </FormDialog>
      )}
    </>
  );
}

// Mail outcomes the inviter should act on (#539): the address bounced or is stopped, or the mail did not go out.
const INVITE_MAIL_PROBLEMS: ReadonlySet<string> = new Set(['bounced', 'complained', 'suppressed', 'failed', 'ambiguous']);

// `entitiesLoading`: until the org's entities are read, a scope's names are not known, so no name reads as removed.
export function PendingInvites({ entities, entitiesLoading }: { entities: LegalEntity[]; entitiesLoading: boolean }) {
  const root = useTranslations();
  const t = useTranslations('settings');
  const entityName = (id: string) => entities.find((e) => e.id === id)?.name ?? (entitiesLoading ? '…' : t('inviteEntityGone'));
  const f = useFormat();
  const invites = useQuery(orpc.org.listInvites.queryOptions());
  const revoke = useMutation(
    orpc.org.revokeInvite.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.org.listInvites.key() }),
    }),
  );
  if (invites.isLoading) return <RowsSkeleton rows={1} />;
  if (invites.error) return <ErrorText>{errorMessage(invites.error)}</ErrorText>;
  if (!invites.data?.length) return null;
  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-muted-foreground">{t('pendingInvites')}</p>
      <ul className="mt-2 divide-y">
        {invites.data.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate text-foreground">{i.email}</p>
              <p className="text-xs text-subtle-foreground">
                {i.status === 'expired' ? t('expired') : t('expiresAt', { at: f.dateTime(i.expiresAt) })}
                {i.invitedBy ? ` · ${t('invitedBy', { name: i.invitedBy })}` : ''}
              </p>
              {i.roleKey && <p className="text-xs text-muted-foreground">{t('inviteDepartmentOf', { role: root(`memberRoles.roles.${asRoleKey(i.roleKey)}`) })}</p>}
              {i.legalEntityIds && i.legalEntityIds.length > 0 && (
                <p className="text-xs text-muted-foreground">{t('inviteScopedTo', { entities: i.legalEntityIds.map(entityName).join(', ') })}</p>
              )}
              {i.mail && (
                <p className={`text-xs ${INVITE_MAIL_PROBLEMS.has(i.mail) ? 'text-destructive' : 'text-subtle-foreground'}`}>
                  {t(`inviteMail.${i.mail}`)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={i.status === 'expired' ? 'warning' : 'secondary'}>{root(`roles.${i.role}`)}</Badge>
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ inviteId: i.id })}>
                {t('revoke')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
    </div>
  );
}

// The members of the org, their roles and the invitations (the members tab). Focusable, so the approval rule's refusal can take the reader to the role assignments (#1425).
// Owners and admins see who holds which role; owners give and take them back (#1279).
export function MembersCard({ members, me, isOwner, canManage, inviteEmail }: { members: MemberRow[]; me: string | undefined; isOwner: boolean; canManage: boolean; inviteEmail: string | undefined }) {
  const root = useTranslations();
  const t = useTranslations('settings');
  const memberRoles = useQuery({ ...orpc.org.memberRoles.queryOptions(), enabled: canManage });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: canManage });
  // An owner may change their own role only while another owner remains (otherwise the server refuses LAST_OWNER).
  const owners = members.filter((m) => m.role === 'owner').length;
  const controlsFor = (userId: string) => isOwner && me !== undefined && (userId !== me || owners > 1);
  return (
    <Card id={MEMBERS_CARD_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none">
      <p className="text-sm font-medium text-muted-foreground">{t('members')}</p>
      <ul className="mt-3 divide-y">
        {members.map((m) => (
          <li key={m.userId} className="py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-foreground">{m.displayName ?? m.email}</span>
              {controlsFor(m.userId) ? <MemberControls member={m} self={m.userId === me} /> : <Badge variant={m.role === 'owner' ? 'brand' : 'secondary'}>{root(`roles.${m.role}`)}</Badge>}
            </div>
            {memberRoles.data && (
              <MemberRolesRow userId={m.userId} name={m.displayName ?? m.email} baseRole={m.role} data={memberRoles.data} entities={entities.data ?? []} isOwner={isOwner} />
            )}
            {isOwner && me !== undefined && m.userId !== me && <MemberSessions userId={m.userId} name={m.displayName ?? m.email} />}
          </li>
        ))}
      </ul>
      {/* The roles could not be read: say so with a retry, instead of showing members as holding none (#1279). */}
      {(memberRoles.error || entities.error) && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <ErrorText>{root('memberRoles.loadFailed', { reason: errorMessage(memberRoles.error ?? entities.error) })}</ErrorText>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (memberRoles.error) void memberRoles.refetch();
              if (entities.error) void entities.refetch();
            }}
          >
            {root('memberRoles.retry')}
          </Button>
        </div>
      )}
      {canManage && (
        <>
          <InviteMember isOwner={isOwner} initialEmail={inviteEmail} entities={entities.data ?? []} catalog={memberRoles.data?.roles ?? []} members={members} />
          <PendingInvites entities={entities.data ?? []} entitiesLoading={entities.isLoading} />
        </>
      )}
    </Card>
  );
}
