// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { accountingEn } from '../../../../content/accounting-en';
import { en } from '../../../../content/en';

export const alt = accountingEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: accountingEn.appName, title: accountingEn.ogTitle, tagline: en.footer.tagline });
}
