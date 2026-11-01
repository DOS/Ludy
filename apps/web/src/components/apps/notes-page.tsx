// SPDX-License-Identifier: AGPL-3.0-only
import { en } from '../../content/en';
import { notesEn } from '../../content/notes-en';
import { notesVi } from '../../content/notes-vi';
import { APP_PAGES } from '../../content/site';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import { DataVisual, MyWorkVisual, NotesHero, ShareVisual, WorkplaceVisual } from './notes-visuals';

// The Ludy Notes page in either language: the shared app page with this app's copy, the Notes screen as its hero
// picture and one visual per group of features. The group ids are those of the copy.
export function NotesPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? notesVi : notesEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      otherLangHref={APP_PAGES.notes[lang === 'vi' ? 'en' : 'vi']}
      hero={<NotesHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <ShareVisual {...props} />,
        [copy.groups.items[1]!.id]: <WorkplaceVisual {...props} />,
        [copy.groups.items[2]!.id]: <MyWorkVisual {...props} />,
        [copy.groups.items[3]!.id]: <DataVisual {...props} />,
      }}
    />
  );
}
