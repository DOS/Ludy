// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { en } from '../../../../content/en';
import { teamworkEn } from '../../../../content/teamwork-en';

export const alt = teamworkEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: teamworkEn.appName, title: teamworkEn.ogTitle, tagline: en.footer.tagline });
}
