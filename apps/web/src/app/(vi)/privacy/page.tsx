// SPDX-License-Identifier: AGPL-3.0-only
import { PrivacyPage } from '../../../components/privacy-page';
import { legalPageMetadata } from '../../../components/root-document';
import { privacyVi } from '../../../content/privacy-vi';
import { LEGAL_PAGES } from '../../../content/site';

export const metadata = legalPageMetadata(privacyVi.meta, 'vi', LEGAL_PAGES.privacy.path);

export default function PrivacyViPage() {
  return <PrivacyPage lang="vi" />;
}
