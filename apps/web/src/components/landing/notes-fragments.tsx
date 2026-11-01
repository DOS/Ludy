// SPDX-License-Identifier: AGPL-3.0-only
import { Bell, CornerUpRight, Link2, Lock, Pin, Users } from 'lucide-react';
import type { Dictionary } from '../../content/vi';
import { Chip } from './ui';

type Notes = Dictionary['modules']['notes'];

// The pieces of Ludy Notes drawn from the real screens with the sample company's data: the list of notes with their
// private or shared mark, and one member's own to-dos grouped by due day. Used by the home page's Ludy Notes card and by
// the Ludy Notes page.
export function NotesList({ notes }: { notes: Notes }) {
  return (
    <figure className="min-w-0 rounded-md border border-line bg-bg">
      <figcaption className="border-b border-line px-3 py-2.5 text-sm font-semibold">{notes.listTitle}</figcaption>
      <ul className="divide-y divide-line">
        {notes.items.map((note) => (
          <li key={note.title} className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5 text-[13px]">
            <span className="flex items-start gap-1.5">
              {note.pinned ? (
                <>
                  <Pin className="mt-0.5 size-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
                  <span className="sr-only">{notes.pinned}: </span>
                </>
              ) : null}
              <span className="min-w-0 font-medium">{note.title}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Chip tone={note.shared ? 'neutral' : 'accent'}>
                {note.shared ? <Users className="size-3" aria-hidden="true" /> : <Lock className="size-3" aria-hidden="true" />}
                {note.shared ? notes.shared : notes.private}
              </Chip>
              {note.tags.map((tag) => (
                <span key={tag} className="rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-muted">
                  {tag}
                </span>
              ))}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-subtle">
              <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only">{notes.linkLabel}: </span>
              <span className="min-w-0 truncate">{note.link}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function TodoList({ notes }: { notes: Notes }) {
  return (
    <figure className="min-w-0 rounded-md border border-line bg-bg">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line px-3 py-2.5">
        <span className="text-sm font-semibold">{notes.todoTitle}</span>
        <span className="text-xs text-subtle">{notes.todoSub}</span>
      </figcaption>
      <div className="flex flex-col divide-y divide-line">
        {notes.groups.map((group) => (
          <section key={group.label} className="px-3 py-2.5">
            <h4 className={`text-[11px] font-semibold ${group.tone === 'warn' ? 'text-warn' : group.tone === 'accent' ? 'text-accent-ink' : 'text-subtle'}`}>{group.label}</h4>
            <ul className="mt-1.5 flex flex-col gap-2.5">
              {group.items.map((todo) => (
                <li key={todo.title} className="flex items-start gap-2.5 text-[13px]">
                  <span className="mt-0.5 inline-flex size-4 shrink-0 rounded-[4px] border border-line-strong/70 bg-surface" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-medium">{todo.title}</span>
                    <span className="num flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
                      {todo.remind ? <Bell className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                      {todo.meta}
                    </span>
                    {todo.steps ? <span className="text-xs text-subtle">{todo.steps}</span> : null}
                    {todo.note ? (
                      <Chip tone="accent" wrap className="self-start">
                        <CornerUpRight className="size-3" aria-hidden="true" />
                        {todo.note}
                      </Chip>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </figure>
  );
}
