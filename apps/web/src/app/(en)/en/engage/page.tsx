// SPDX-License-Identifier: AGPL-3.0-only
import { EngagePage } from '../../../../components/apps/engage-page';
import { appPageMetadata } from '../../../../components/root-document';
import { engageEn } from '../../../../content/engage-en';
import { APP_PAGES } from '../../../../content/site';

export const metadata = appPageMetadata(engageEn, 'en', APP_PAGES.engage.path);

export default function EngageEnPage() {
  return <EngagePage lang="en" />;
}
