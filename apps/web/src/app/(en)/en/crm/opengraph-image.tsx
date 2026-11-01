// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { crmEn } from '../../../../content/crm-en';
import { en } from '../../../../content/en';

export const alt = crmEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: crmEn.appName, title: crmEn.ogTitle, tagline: en.footer.tagline });
}
