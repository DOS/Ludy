// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { engageEn } from '../../../../content/engage-en';
import { en } from '../../../../content/en';

export const alt = engageEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: engageEn.appName, title: engageEn.ogTitle, tagline: en.footer.tagline });
}
