// SPDX-License-Identifier: AGPL-3.0-only
import { Check, Link2, Lock, Pin, Search, Users } from 'lucide-react';
import type { NotesCopy } from '../../content/notes-vi';
import type { Dictionary } from '../../content/vi';
import { NotesList, TodoList } from '../landing/notes-fragments';
import { Chip } from '../landing/ui';

// The pieces of Ludy Notes the page draws, in HTML with the home page's sample company: each is something the product
// shows today. Panel titles are not headings, so the page's outline stays the section titles and the feature groups.
type Props = { dict: Dictionary; copy: NotesCopy };

function FauxButton({ children, primary = false }: { children: string; primary?: boolean }) {
  return (
    <span
      className={`inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium ${primary ? 'border-line-strong/70 bg-surface-2' : 'border-line bg-surface text-muted'}`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

// An open note as the Notes screen draws it: the write and preview tabs, the Markdown as it renders, its tags and the
// record it is attached to.
function NotePreview({ copy }: { copy: NotesCopy }) {
  const f = copy.fragments.note;
  return (
    <figure aria-label={f.label} className="flex min-w-0 flex-col rounded-md border border-line bg-bg">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <span className="min-w-0 text-sm font-semibold">{f.title}</span>
        <Chip tone="ok">
          <Check className="size-3" strokeWidth={3} aria-hidden="true" />
          {f.saved}
        </Chip>
      </figcaption>
      <div className="flex gap-4 border-b border-line px-3 pt-2 text-xs" aria-hidden="true">
        {f.tabs.map((tab, i) => (
          <span key={tab} className={`border-b-2 pb-1.5 ${i === f.current ? 'border-accent font-semibold text-fg' : 'border-transparent text-subtle'}`}>
            {tab}
          </span>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-3 px-3 py-3 text-[13px]">
        <p className="font-display text-base font-semibold">{f.heading}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
          {f.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
        <ul className="flex flex-col gap-1.5">
          {f.checks.map((check) => (
            <li key={check.text} className="flex items-start gap-2">
              <span
                className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${check.done ? 'border-ok bg-ok text-bg' : 'border-line-strong/70 bg-surface'}`}
                aria-hidden="true"
              >
                {check.done ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
              <span className={check.done ? 'text-subtle line-through' : ''}>{check.text}</span>
            </li>
          ))}
        </ul>
        <p className="text-accent-ink underline">{f.linkText}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5 text-xs text-subtle">
        <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {f.attachedLabel}: <span className="text-muted">{f.attached}</span>
        </span>
        {f.tags.map((tag) => (
          <span key={tag} className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-muted">
            {tag}
          </span>
        ))}
      </div>
    </figure>
  );
}

// The hero: the Notes screen, the list of notes with their private or shared mark beside the open note.
export function NotesHero({ dict, copy }: Props) {
  return (
    <figure aria-label={copy.fragments.note.label} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-4 text-xs text-subtle">
        <span>{dict.shell.org}</span>
        <Chip tone="neutral">{copy.fragments.sample}</Chip>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <NotesList notes={dict.modules.notes} />
        <NotePreview copy={copy} />
      </div>
    </figure>
  );
}

// Notes: the confirmation before a private note becomes shared with the organization.
export function ShareVisual({ copy }: Props) {
  const f = copy.fragments.share;
  return (
    <figure className="rounded-md border border-line bg-bg p-4">
      <figcaption className="sr-only">{copy.fragments.sample}</figcaption>
      <div className="flex items-center gap-2 text-xs text-subtle">
        <Lock className="size-3.5" aria-hidden="true" />
        <Users className="size-3.5" aria-hidden="true" />
      </div>
      <p className="mt-2 text-sm font-semibold">{f.title}</p>
      <p className="mt-2 text-sm text-muted">{f.body}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <FauxButton>{f.cancel}</FauxButton>
        <FauxButton primary>{f.confirm}</FauxButton>
      </div>
    </figure>
  );
}

// Notes where you work: the Notes panel on a vendor's screen, and the same notes found from the command palette.
export function WorkplaceVisual({ copy }: Props) {
  const f = copy.fragments.panel;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <figure className="rounded-md border border-line bg-bg">
        <figcaption className="border-b border-line px-4 py-3">
          <span className="block text-sm font-semibold">{f.screen}</span>
          <span className="block text-xs text-subtle">{f.sub}</span>
        </figcaption>
        <div className="px-4 py-3">
          <div className="text-xs font-semibold text-subtle">{f.title}</div>
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {f.notes.map((note) => (
              <li key={note.title} className="flex min-w-0 flex-col gap-1.5 py-2.5 text-[13px] first:pt-0">
                <span className="flex items-start gap-1.5">
                  {note.pinned ? (
                    <>
                      <Pin className="mt-0.5 size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
                      <span className="sr-only">{f.pinned}: </span>
                    </>
                  ) : null}
                  <span className="min-w-0 font-medium">{note.title}</span>
                </span>
                <span>
                  <Chip tone={note.shared ? 'neutral' : 'accent'}>
                    {note.shared ? <Users className="size-3" aria-hidden="true" /> : <Lock className="size-3" aria-hidden="true" />}
                    {note.shared ? f.shared : f.private}
                  </Chip>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </figure>
      <figure className="rounded-md border border-line bg-bg">
        <figcaption className="sr-only">{f.paletteLabel}</figcaption>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm">
          <Search className="size-4 shrink-0 text-subtle" aria-hidden="true" />
          <span>{f.query}</span>
        </div>
        <div className="px-4 py-3">
          <div className="text-xs font-semibold text-subtle">{f.group}</div>
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
            {f.results.map((result, i) => (
              <li key={result} className={`rounded-sm px-2 py-1.5 ${i === 0 ? 'bg-accent-soft font-medium' : ''}`}>
                {result}
              </li>
            ))}
          </ul>
        </div>
      </figure>
    </div>
  );
}

// My work: the to-dos of one member by due day, and the dialog that hands one to a position as a team task.
export function MyWorkVisual({ dict, copy }: Props) {
  const f = copy.fragments.handover;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <span className="sr-only">{copy.fragments.sample}</span>
      <TodoList notes={dict.modules.notes} />
      <figure className="rounded-md border border-line bg-bg p-4 text-sm">
        <figcaption className="font-semibold">{f.title}</figcaption>
        <p className="mt-2 text-xs text-muted">{f.hint}</p>
        <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
          <div>
            <dt className="text-xs text-subtle">{f.positionLabel}</dt>
            <dd className="mt-0.5 rounded-sm border border-line bg-surface px-2.5 py-1.5">{f.position}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">{f.taskLabel}</dt>
            <dd className="mt-0.5 rounded-sm border border-line bg-surface px-2.5 py-1.5">{f.task}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">{f.descLabel}</dt>
            <dd className="mt-0.5 rounded-sm border border-line bg-surface px-2.5 py-1.5">{f.desc}</dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end">
          <FauxButton primary>{f.button}</FauxButton>
        </div>
      </figure>
    </div>
  );
}

// Your data: the two downloads, and what happens to a leaving member's private notes.
export function DataVisual({ copy }: Props) {
  const f = copy.fragments.data;
  return (
    <figure className="rounded-md border border-line bg-bg">
      <figcaption className="sr-only">{copy.fragments.sample}</figcaption>
      <div className="px-4 py-3">
        <p className="text-sm font-semibold">{f.title}</p>
        <p className="mt-1 text-xs text-subtle">{f.note}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <FauxButton primary>{f.markdown}</FauxButton>
          <FauxButton primary>{f.json}</FauxButton>
        </div>
      </div>
      <div className="border-t border-line px-4 py-3 text-xs">
        <p className="font-semibold text-fg">{f.leaveTitle}</p>
        <p className="mt-1 text-muted">{f.leave}</p>
      </div>
    </figure>
  );
}
