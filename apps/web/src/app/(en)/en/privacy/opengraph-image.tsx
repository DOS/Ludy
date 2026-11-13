// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { en } from '../../../../content/en';
import { privacyEn } from '../../../../content/privacy-en';

export const alt = privacyEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: 'Ludy', title: privacyEn.ogTitle, tagline: en.footer.tagline });
}
