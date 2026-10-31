// Detects the real type of an uploaded file from its first bytes. The declared MIME type and the
// filename extension come from the sender and are never trusted on their own.
const EXTENSIONS: Record<string, string> = {
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
};

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

// CSV text, as a bank exports a statement (#2142): UTF-8 or UTF-16 with its byte order mark, no control characters, and
// at least two lines in the first 4 KiB with a comma, semicolon or tab (a header and a line of a table, which has two
// columns at least, a date and an amount; the title and the account above them have none). Plain text with commas passes too, so where a name is known
// (an email attachment, an entry of a ZIP) the caller also asks for ".csv" (isCsvName); the file is then read in the
// sandbox, which decides whether it is a statement at all.
function looksLikeCsv(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  const utf16 = head[0] === 0xff && head[1] === 0xfe;
  if (!utf16 && head.includes(0)) return false;
  const text = utf16 ? new TextDecoder('utf-16le').decode(head.subarray(2)) : new TextDecoder('utf-8').decode(head);
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return [',', ';', '\t'].some((delimiter) => lines.filter((line) => line.split(delimiter).length > 1).length >= 2);
}

// A name that says CSV; with the type text/csv it is what an attachment or an archive entry needs to be filed.
export const isCsvName = (name: string): boolean => /\.csv$/i.test(name.trim());

export function sniffType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  // A ZIP archive (a local file header, or the end record of an empty one). Accepted only as a batch of documents
  // (#314); the sandbox opens it, and refuses an Office file, which is a ZIP too.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  // XML: optional UTF-8 BOM and whitespace, then "<".
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < bytes.length && i < 1024 && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i] ?? 0)) i += 1;
  if (bytes[i] === 0x3c) return 'application/xml';
  if (looksLikeCsv(bytes)) return 'text/csv';
  return null;
}

// Keeps the sender's base name but forces the extension that matches the detected type.
export function safeFilename(name: string, type: string): string {
  const base = (name.replace(/[\\/]/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '') || 'tep').slice(0, 200);
  return `${base}.${EXTENSIONS[type] ?? 'bin'}`;
}
