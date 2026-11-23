// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { esignEn } from '../../../../content/esign-en';
import { en } from '../../../../content/en';

export const alt = esignEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: esignEn.appName, title: esignEn.ogTitle, tagline: en.footer.tagline });
}
