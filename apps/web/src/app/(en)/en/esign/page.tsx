// SPDX-License-Identifier: AGPL-3.0-only
import { EsignPage } from '../../../../components/apps/esign-page';
import { appPageMetadata } from '../../../../components/root-document';
import { esignEn } from '../../../../content/esign-en';
import { APP_PAGES } from '../../../../content/site';

export const metadata = appPageMetadata(esignEn, 'en', APP_PAGES.sign.path);

export default function EsignEnPage() {
  return <EsignPage lang="en" />;
}
