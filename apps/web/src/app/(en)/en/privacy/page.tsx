// SPDX-License-Identifier: AGPL-3.0-only
import { PrivacyPage } from '../../../../components/privacy-page';
import { legalPageMetadata } from '../../../../components/root-document';
import { privacyEn } from '../../../../content/privacy-en';
import { LEGAL_PAGES } from '../../../../content/site';

export const metadata = legalPageMetadata(privacyEn.meta, 'en', LEGAL_PAGES.privacy.path);

export default function PrivacyEnPage() {
  return <PrivacyPage lang="en" />;
}
