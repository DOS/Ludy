// SPDX-License-Identifier: AGPL-3.0-only
import { EngagePage } from '../../../components/apps/engage-page';
import { appPageMetadata } from '../../../components/root-document';
import { engageVi } from '../../../content/engage-vi';
import { APP_PAGES } from '../../../content/site';

export const metadata = appPageMetadata(engageVi, 'vi', APP_PAGES.engage.path);

export default function EngageViPage() {
  return <EngagePage lang="vi" />;
}
