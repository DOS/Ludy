// SPDX-License-Identifier: AGPL-3.0-only
// What a customer's mail carries besides its text (issue #2758, plan docs/plan/conversations.md section 6.7 "Attachments"). The sandboxed
// crove-extract parser hands the worker each attachment's bytes (base64) and file name; nothing is fetched from a URL in the mail. An image is
// kept only when its own first bytes say JPEG, PNG, WebP or GIF (never the name or the MIME header, which the sender chose), within the same size
// cap as a platform's image and at most CONVERSATION_ATTACHMENTS_MAX a mail; it is stored through the conversation attachment store and shown
// as an image, never as HTML. Any other file, and an image left out, shows as a line of name, size and type in the message text with no bytes.
// A file that fails any rule only loses its own bytes: the mail's text always arrives.
//
// The file names are the sender's text: control and bidirectional characters are removed and the length cut. Nothing here logs or returns a name
// or a byte except in the note lines (the message body) and the planned images (handed to the store).
import { CONVERSATION_ATTACHMENTS_MAX, CONVERSATION_IMAGE_MAX_BYTES, type ConversationImageType } from '@crove/kernel-contract';
import { sha256Hex } from '@crove/kernel-runtime';
import { inspectConversationImage } from './conversation-media.ts';

// The attachments looked at in one mail: the parser's own cap, so a hostile mail cannot make a long list.
const MAIL_FILES_LOOKED_AT = 20;
// The longest note listing the files a mail carried, so the list never crowds out the text.
export const MAIL_FILE_NOTE_MAX = 1500;
const NAME_MAX = 80;
// A real image of a format the store does not take: said so, not called invalid.
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set(['heic', 'heif', 'bmp', 'tif', 'tiff']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'bmp', 'tif', 'tiff', 'heif', 'svg']);

export interface MailImage {
  bytes: Buffer;
  contentType: ConversationImageType;
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface MailFiles {
  // The images to store, in the mail's order.
  images: MailImage[];
  // The lines of the note that lists what was not stored as an image (empty when there is nothing to list).
  lines: string[];
}

// A file name as a short single line: the last path segment, no control, bidirectional or zero-width characters.
export function cleanFileName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // oxlint-disable-next-line no-control-regex
  const plain = base.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim();
  return plain === '' ? 'tệp không tên' : plain.slice(0, NAME_MAX);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString().replace('.', ',')} MB`;
}

// The type shown for a file that is not stored as an image: PDF by its own bytes, else the name's extension as the sender wrote it (a label only,
// never a decision). A name that claims an image whose bytes are not one says so.
function typeLabel(name: string, bytes: Buffer): string {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (!extension) return 'tệp';
  return IMAGE_EXTENSIONS.has(extension) ? (UNSUPPORTED_IMAGE_EXTENSIONS.has(extension) ? 'ảnh định dạng chưa hỗ trợ' : 'không phải ảnh hợp lệ') : extension.toUpperCase();
}

export function readMailFiles(attachments: ReadonlyArray<{ filename: string | null; content: string }>): MailFiles {
  const images: MailImage[] = [];
  const lines: string[] = [];
  for (const attachment of attachments.slice(0, MAIL_FILES_LOOKED_AT)) {
    const bytes = Buffer.from(attachment.content, 'base64');
    if (bytes.byteLength === 0) continue;
    const name = cleanFileName(attachment.filename);
    const image = inspectConversationImage(bytes);
    if (!image) {
      lines.push(`- ${name} (${typeLabel(name, bytes)}, ${sizeLabel(bytes.byteLength)})`);
    } else if (bytes.byteLength > CONVERSATION_IMAGE_MAX_BYTES) {
      lines.push(`- ${name} (ảnh ${sizeLabel(bytes.byteLength)}, quá lớn nên không lưu)`);
    } else if (images.length >= CONVERSATION_ATTACHMENTS_MAX) {
      lines.push(`- ${name} (ảnh ${sizeLabel(bytes.byteLength)}, thư có quá nhiều ảnh nên không lưu)`);
    } else {
      images.push({ bytes, ...image, sha256: sha256Hex(bytes) });
    }
  }
  return { images, lines };
}

// The note that lists the files kept out of the thread as bytes, or '' when there is none. Cut at MAIL_FILE_NOTE_MAX with a closing line.
export function mailFilesNote(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  let note = 'Tệp đính kèm (chỉ hiện tên, không lưu nội dung):';
  for (const [i, line] of lines.entries()) {
    if (note.length + line.length + 1 > MAIL_FILE_NOTE_MAX) return `${note}\n- và ${lines.length - i} tệp khác`;
    note += `\n${line}`;
  }
  return note;
}
