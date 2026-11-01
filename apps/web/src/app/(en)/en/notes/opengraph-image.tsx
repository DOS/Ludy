// SPDX-License-Identifier: AGPL-3.0-only
import { OG_SIZE, renderOgImage } from '../../../../components/og-image';
import { en } from '../../../../content/en';
import { notesEn } from '../../../../content/notes-en';

export const alt = notesEn.meta.title;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderOgImage({ name: notesEn.appName, title: notesEn.ogTitle, tagline: en.footer.tagline });
}
