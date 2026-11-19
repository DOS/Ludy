// The org's event types in Settings (issue #1314), with the crm module: the kinds of meeting a client books with a
// member on the booking page (C3). Owners and admins add and change any; a member those they host; a viewer reads.
// Event types are archived, not deleted. The server enforces every rule; the screen offers only what can succeed.
// Team types (#1373): owners and admins pick round-robin or collective and the co-hosts; a member sees them only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { EVENT_TYPE_ASSIGNMENTS, EVENT_TYPE_LOCATION_KINDS, type EventType, type EventTypeAssignment, type EventTypeLocationKind } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { FormPanel } from '../components/form-panel.tsx';
import { ErrorText, FieldError, fieldControl, fieldErrorId, focusFirstInvalid, RowsSkeleton, useFieldErrors } from '../components/ui.tsx';
import { CopyBookingLinkButton, OpenBookingPageLink, bookingUrlOf } from '../components/booking-link.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { appOrigin, BOOKING_EVENT_TYPES_ID, bookingLinkOf } from '../lib/booking.ts';
import {
  coHostChoices,
  draftOf,
  EVENT_TYPE_CHECKED_FIELDS,
  eventTypeFieldInvalid,
  hostChoices,
  inputOf,
  mayManage,
  withCoHost,
  withHost,
  withTitle,
  type EventTypeCheckedField,
  type EventTypeDraft,
  type EventTypeMember,
} from '../lib/event-types.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.crm.eventTypes.list.key() });

const nameOf = (members: readonly EventTypeMember[], userId: string) => {
  const m = members.find((x) => x.userId === userId);
  return m ? (m.displayName ?? m.email) : null;
};

function EventTypeForm({
  slug,
  type,
  members,
  me,
  manager,
  pending,
  failed,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  slug: string;
  type: EventType | null;
  members: readonly EventTypeMember[];
  me: string;
  manager: boolean;
  pending: boolean;
  // The error of the last save: the options open, so a link already taken or a field the server refused is in view.
  failed?: unknown;
  submitLabel: string;
  onSubmit: (input: Exclude<ReturnType<typeof inputOf>, { invalid: unknown }>['input']) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('eventTypes');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<EventTypeDraft>(() => draftOf(type, me));
  // Typed input that is not saved yet: the panel asks before it throws it away.
  const [initial] = useState(() => JSON.stringify(draftOf(type, me)));
  const dirty = JSON.stringify(draft) !== initial;
  // The first form shows what a new type needs (name, length, format, place); buffers, notice, host and the rest sit under "Tùy chọn khác" (#3643). Editing opens them.
  const [more, setMore] = useState(type !== null);
  const moreId = useId();
  useEffect(() => {
    if (failed) setMore(true);
  }, [failed]);
  // A name with no letters or digits makes no link: the last part of the link must then be typed, so the field shows at once.
  const slugBlank = draft.slug.trim() === '' && draft.title.trim() !== '';
  // A Google Meet per booking needs the host's own Google connection with write-back on, so only the host picks it, for a one-host type; a type that already has
  // it keeps the option, so the form still shows what it is.
  const connections = useQuery(orpc.calendar.connections.queryOptions());
  // writeBack is the member's switch; canWriteBack says the grant still carries the events permission (a plain reconnect drops it while the switch stays on).
  const meetReady = (connections.data ?? []).some((c) => c.provider === 'google' && c.status === 'active' && c.writeBack && c.canWriteBack);
  const mayPickMeet = meetReady && draft.hostUserId === me && draft.assignment === 'single';
  const locationKinds = EVENT_TYPE_LOCATION_KINDS.filter((k) => k !== 'google_meet' || mayPickMeet || draft.locationKind === 'google_meet');
  // A Meet type whose host or assignment is changed away from the rule (the host themselves, alone, with Google connected) falls back to a link before it is
  // submitted: the server would refuse it with EVENT_TYPE_MEET_UNAVAILABLE. Every change of the host or the assignment goes through it.
  const meetOnlyWhereAllowed = (next: EventTypeDraft): EventTypeDraft =>
    next.locationKind === 'google_meet' && !(meetReady && next.hostUserId === me && next.assignment === 'single') ? { ...next, locationKind: 'video' } : next;
  const set = <K extends keyof EventTypeDraft>(key: K, value: EventTypeDraft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      return key === 'hostUserId' || key === 'assignment' ? meetOnlyWhereAllowed(next) : next;
    });
  // Each number's error sits under it, the co-hosts' under their list, checked on leaving the field and on submit
  // (DESIGN.md §4.2, #2004); the server checks again.
  const ids = useId();
  const idOf = (field: EventTypeCheckedField) => `${ids}-${field}`;
  const fields = useFieldErrors<EventTypeCheckedField>((field) =>
    !eventTypeFieldInvalid(draft, field) ? null : field === 'coHostUserIds' ? t('coHostsNeeded') : t('numberInvalid'),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = inputOf(draft);
    if (!fields.checkAll(EVENT_TYPE_CHECKED_FIELDS) || 'invalid' in result) {
      // A problem under "Tùy chọn khác" opens it first, so the field to focus is on screen.
      if (more) focusFirstInvalid(form);
      else {
        setMore(true);
        requestAnimationFrame(() => focusFirstInvalid(form));
      }
      return;
    }
    onSubmit(result.input);
  };
  const number = (key: Exclude<EventTypeCheckedField, 'coHostUserIds'>, placeholder?: string) => (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t(`fields.${key}`)}
        <Input
          {...fieldControl(idOf(key), { error: Boolean(fields.of(key)) })}
          inputMode="decimal"
          className="w-28"
          value={draft[key]}
          placeholder={placeholder}
          onChange={(e) => {
            set(key, e.target.value);
            fields.edit(key);
          }}
          onBlur={(e) => fields.blur(key, e.target.value)}
        />
      </label>
      <FieldError id={idOf(key)} className="max-w-48">
        {fields.of(key)}
      </FieldError>
    </div>
  );
  const coHostsError = fields.of('coHostUserIds');
  return (
    <FormPanel
      title={type ? t('editOf', { title: type.title }) : t('addTitle')}
      {...(type ? {} : { description: t('addHint') })}
      busy={pending}
      dirty={dirty}
      wide
      onClose={onCancel}
      onSubmit={submit}
      footer={(requestClose) => (
        <>
          <Button type="button" variant="ghost" disabled={pending} onClick={requestClose}>
            {tc('cancel')}
          </Button>
          <Button loading={pending} type="submit" disabled={pending || !draft.title.trim() || !draft.slug.trim()}>
            {submitLabel}
          </Button>
        </>
      )}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('fields.title')}
        <Input required maxLength={120} placeholder={t('titlePlaceholder')} value={draft.title} onChange={(e) => setDraft((d) => withTitle(d, e.target.value))} />
      </label>
      <div className="flex flex-wrap gap-3">
        {number('durationMin')}
        <label className="flex min-w-40 flex-col gap-1 text-xs text-muted-foreground">
          {t('fields.locationKind')}
          <NativeSelect value={draft.locationKind} onChange={(e) => set('locationKind', e.target.value as EventTypeLocationKind)}>
            {locationKinds.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`locations.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          {t('fields.locationValue')}
          <Input maxLength={500} placeholder={t(`locationPlaceholders.${draft.locationKind}`)} value={draft.locationValue} onChange={(e) => set('locationValue', e.target.value)} />
        </label>
      </div>
      {draft.locationKind === 'google_meet' ? (
        <p className="text-xs text-subtle-foreground" data-testid="meet-hint">
          {t('meetHint')}
        </p>
      ) : (
        !mayPickMeet && (
          <p className="text-xs text-subtle-foreground" data-testid="meet-needs-google">
            {t('meetNeedsGoogle')}
          </p>
        )
      )}
      {/* The link a client opens, made from the name (#3643): the owner reads it rather than edits a slug. */}
      <p className="break-all text-xs text-subtle-foreground" data-testid="event-type-link">
        {t('linkIs')}{' '}
        {draft.slug ? <span className="font-mono text-foreground">{bookingLinkOf(appOrigin(), slug, draft.slug)}</span> : <span>{t('linkPending')}</span>}
      </p>
      <Button type="button" variant="ghost" size="sm" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((m) => !m)}>
        {t('moreOptions')}
      </Button>
      {(more || slugBlank) && (
        <div id={moreId} className="space-y-2">
          <div className="flex flex-wrap gap-3">
            {number('bufferBeforeMin')}
            {number('bufferAfterMin')}
            {number('minNoticeHours')}
            {number('horizonDays')}
            {number('dailyLimit', t('noLimit'))}
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {t('fields.host')}
              <NativeSelect value={draft.hostUserId} disabled={!manager} onChange={(e) => setDraft((d) => meetOnlyWhereAllowed(withHost(d, e.target.value)))}>
                {hostChoices(members, me, manager).map((m) => (
                  <NativeSelectOption key={m.userId} value={m.userId}>
                    {m.displayName ?? m.email}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex min-w-48 flex-col gap-1 text-xs text-muted-foreground">
              {t('fields.assignment')}
              <NativeSelect
                value={draft.assignment}
                disabled={!manager}
                onChange={(e) => {
                  set('assignment', e.target.value as EventTypeAssignment);
                  fields.edit('coHostUserIds');
                }}
              >
                {EVENT_TYPE_ASSIGNMENTS.map((a) => (
                  <NativeSelectOption key={a} value={a}>
                    {t(`assignments.${a}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>
          {draft.assignment !== 'single' && (
            <fieldset className="space-y-1" aria-invalid={Boolean(coHostsError) || undefined} aria-describedby={coHostsError ? fieldErrorId(idOf('coHostUserIds')) : undefined}>
              <legend className="text-xs text-muted-foreground">{t('fields.coHostUserIds')}</legend>
              <p className="text-xs text-subtle-foreground">{t(`assignmentHints.${draft.assignment}`)}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {coHostChoices(members, draft.hostUserId).map((m) => (
                  <label key={m.userId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.coHostUserIds.includes(m.userId)}
                      disabled={!manager}
                      onCheckedChange={(on) => {
                        setDraft((d) => withCoHost(d, m.userId, on === true));
                        fields.edit('coHostUserIds');
                      }}
                    />
                    {m.displayName ?? m.email}
                  </label>
                ))}
              </div>
              <FieldError id={idOf('coHostUserIds')}>{coHostsError}</FieldError>
            </fieldset>
          )}
          {/* Two types with the same name make the same link: the last part of the link can be typed here (the options open when a save is refused), so a name clash is never a dead end. Changing it breaks links already sent. */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('fields.slug')}
            <span className="flex items-center gap-2 text-sm">
              <span className="text-subtle-foreground">/</span>
              <Input required maxLength={60} className="font-mono" value={draft.slug} onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value, slugEdited: true }))} />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('fields.description')}
            <Textarea maxLength={1000} rows={2} placeholder={t('descriptionPlaceholder')} value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </div>
      )}
      {failed ? <ErrorText>{errorMessage(failed)}</ErrorText> : null}
    </FormPanel>
  );
}

function EventTypeRow({ slug, type, members, me, manager, editor }: { slug: string; type: EventType; members: readonly EventTypeMember[]; me: string; manager: boolean; editor: boolean }) {
  const t = useTranslations('eventTypes');
  const [editing, setEditing] = useState(false);
  const update = useMutation(
    orpc.crm.eventTypes.update.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
    }),
  );
  const setActive = useMutation(orpc.crm.eventTypes.setActive.mutationOptions({ onSuccess: refresh }));
  // A viewer changes nothing, even a type they still host.
  const canManage = editor && mayManage(type, me, manager);
  const host = nameOf(members, type.hostUserId);
  const coHosts = type.coHostUserIds.map((id) => nameOf(members, id)).filter((n): n is string => n !== null);
  return (
    <li className="py-2 text-sm">
      {editing && (
        <EventTypeForm
          slug={slug}
          type={type}
          members={members}
          me={me}
          manager={manager}
          pending={update.isPending}
          failed={update.error}
          submitLabel={t('save')}
          onSubmit={(input) => update.mutate({ eventTypeId: type.id, ...input })}
          onCancel={() => {
            setEditing(false);
            update.reset();
          }}
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-foreground">
            <span className="truncate">{type.title}</span>
            {!type.active && <Badge variant="secondary">{t('archived')}</Badge>}
          </p>
          <p className="text-xs text-subtle-foreground">
            <span className="font-mono">/{type.slug}</span> · {t('minutes', { count: String(type.durationMin) })} · {t(`locations.${type.locationKind}`)}
            {host ? ` · ${t('hostedBy', { name: host })}` : null}
            {type.assignment !== 'single' ? ` · ${t(`assignments.${type.assignment}`)}${coHosts.length > 0 ? `: ${coHosts.join(', ')}` : ''}` : null}
          </p>
          {/* The link to send to a client (#3643): any member may copy or open it; an archived type has no page to send. */}
          {type.active && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              <CopyBookingLinkButton url={bookingUrlOf(slug, type)} title={type.title} />
              <OpenBookingPageLink url={bookingUrlOf(slug, type)} title={type.title} label="view" />
            </div>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { title: type.title })}>
              {t('edit')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={setActive.isPending} onClick={() => setActive.mutate({ eventTypeId: type.id, active: !type.active })}>
              {type.active ? t('archive') : t('restore')}
            </Button>
          </div>
        )}
      </div>
      {(editing ? setActive.error : (update.error ?? setActive.error)) && <ErrorText>{errorMessage(editing ? setActive.error : (update.error ?? setActive.error))}</ErrorText>}
    </li>
  );
}

function AddEventType({ slug, members, me, manager }: { slug: string; members: readonly EventTypeMember[]; me: string; manager: boolean }) {
  const t = useTranslations('eventTypes');
  const [open, setOpen] = useState(false);
  const create = useMutation(
    orpc.crm.eventTypes.create.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        await refresh();
      },
    }),
  );
  return (
    <div className="mt-4">
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('addTitle')}
      </Button>
      {open && (
        <EventTypeForm
          slug={slug}
          type={null}
          members={members}
          me={me}
          manager={manager}
          pending={create.isPending}
          failed={create.error}
          submitLabel={t('add')}
          onSubmit={(input) => create.mutate(input)}
          onCancel={() => {
            setOpen(false);
            create.reset();
          }}
        />
      )}
    </div>
  );
}

// Every member reads the list; role decides what they may change.
export function EventTypesCard({ slug, members, me, role }: { slug: string; members: readonly EventTypeMember[]; me: string; role: EventTypeMember['role'] }) {
  const t = useTranslations('eventTypes');
  const types = useQuery(orpc.crm.eventTypes.list.queryOptions());
  const manager = role === 'owner' || role === 'admin';
  return (
    <Card id={BOOKING_EVENT_TYPES_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {types.isLoading ? (
        <RowsSkeleton />
      ) : types.error ? (
        <ErrorText>{errorMessage(types.error)}</ErrorText>
      ) : (
        <>
          {(types.data ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('empty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(types.data ?? []).map((type) => (
                <EventTypeRow key={`${type.id}:${type.updatedAt}`} slug={slug} type={type} members={members} me={me} manager={manager} editor={role !== 'viewer'} />
              ))}
            </ul>
          )}
          {role !== 'viewer' && <AddEventType slug={slug} members={members} me={me} manager={manager} />}
        </>
      )}
    </Card>
  );
}
