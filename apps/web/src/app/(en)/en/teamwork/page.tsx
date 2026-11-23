// SPDX-License-Identifier: AGPL-3.0-only
import { TeamworkPage } from '../../../../components/apps/teamwork-page';
import { appPageMetadata } from '../../../../components/root-document';
import { APP_PAGES } from '../../../../content/site';
import { teamworkEn } from '../../../../content/teamwork-en';

export const metadata = appPageMetadata(teamworkEn, 'en', APP_PAGES.teamwork.path);

export default function TeamworkEnPage() {
  return <TeamworkPage lang="en" />;
}
