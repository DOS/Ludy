// SPDX-License-Identifier: AGPL-3.0-only
import { EsignPage } from '../../../components/apps/esign-page';
import { appPageMetadata } from '../../../components/root-document';
import { esignVi } from '../../../content/esign-vi';
import { APP_PAGES } from '../../../content/site';

export const metadata = appPageMetadata(esignVi, 'vi', APP_PAGES.sign.path);

export default function EsignViPage() {
  return <EsignPage lang="vi" />;
}
