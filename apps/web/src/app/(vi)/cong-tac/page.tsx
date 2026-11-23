// SPDX-License-Identifier: AGPL-3.0-only
import { TeamworkPage } from '../../../components/apps/teamwork-page';
import { appPageMetadata } from '../../../components/root-document';
import { APP_PAGES } from '../../../content/site';
import { teamworkVi } from '../../../content/teamwork-vi';

export const metadata = appPageMetadata(teamworkVi, 'vi', APP_PAGES.teamwork.path);

export default function TeamworkViPage() {
  return <TeamworkPage lang="vi" />;
}
