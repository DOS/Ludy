// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { en } from '../../../../content/en';
import { hrmEn } from '../../../../content/hrm-en';

export const alt = hrmEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: hrmEn.appName, title: hrmEn.ogTitle, tagline: en.footer.tagline });
}
