// SPDX-License-Identifier: AGPL-3.0-only
import { en } from '../../content/en';
import { teamworkEn } from '../../content/teamwork-en';
import { teamworkVi } from '../../content/teamwork-vi';
import { vi } from '../../content/vi';
import { AppPage } from './app-page';
import { MeetingsVisual, MyWorkVisual, ShareVisual, TeamworkHero, WorkplaceVisual } from './teamwork-visuals';

// The Ludy Cộng tác page (/cong-tac) in either language: the shared app page with this app's copy, its hero picture
// and one visual per group of features. The group ids are those of the copy.
export function TeamworkPage({ lang }: { lang: 'vi' | 'en' }) {
  const dict = lang === 'vi' ? vi : en;
  const copy = lang === 'vi' ? teamworkVi : teamworkEn;
  const props = { dict, copy };
  return (
    <AppPage
      dict={dict}
      copy={copy}
      hero={<TeamworkHero {...props} />}
      visuals={{
        [copy.groups.items[0]!.id]: <MyWorkVisual {...props} />,
        [copy.groups.items[1]!.id]: <ShareVisual {...props} />,
        [copy.groups.items[2]!.id]: <WorkplaceVisual {...props} />,
        [copy.groups.items[3]!.id]: <MeetingsVisual {...props} />,
      }}
    />
  );
}
