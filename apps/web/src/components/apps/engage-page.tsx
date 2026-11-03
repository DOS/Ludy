// SPDX-License-Identifier: AGPL-3.0-only
import { engageEn } from '../../content/engage-en';
import { engageVi } from '../../content/engage-vi';
import { en } from '../../content/en';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import { BoardVisual, BookingVisual, EngageHero, InboxVisual, PostsVisual, ReportsVisual } from './engage-visuals';

// The Ludy Engage page in either language: the shared app page with this app's copy, the app's menu as its hero
// picture and one visual per group of features. The group ids are those of the copy.
export function EngagePage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? engageVi : engageEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      hero={<EngageHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <InboxVisual {...props} />,
        [copy.groups.items[1]!.id]: <BoardVisual {...props} />,
        [copy.groups.items[2]!.id]: <BookingVisual {...props} />,
        [copy.groups.items[3]!.id]: <PostsVisual {...props} />,
        [copy.groups.items[4]!.id]: <ReportsVisual {...props} />,
      }}
    />
  );
}
