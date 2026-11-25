// SPDX-License-Identifier: AGPL-3.0-only
// Saves a file the server built and sent back inside an answer as base64 (a transcript export, #4817): a link to a Blob, clicked once and let go.

/** The bytes of a base64 string. */
export function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function saveBase64File(file: { filename: string; mimeType: string; contentBase64: string }): void {
  const url = URL.createObjectURL(new Blob([bytesOfBase64(file.contentBase64)], { type: file.mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Let go of the address a moment later: some browsers have not started the save when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
