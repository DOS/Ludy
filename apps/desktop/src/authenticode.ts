// SPDX-License-Identifier: AGPL-3.0-only
// Verifies Windows Authenticode signatures, SpcIndirectDataContent SHA-256 file digest (/fd), RFC 3161 TSTInfo
// messageImprint SHA-256 digest (/td), and signed release-manifest.ps1 scripts before Squirrel sees an update.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RELEASE_MANIFEST_SCRIPT_FILENAME = 'release-manifest.ps1';
export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_SPC_INDIRECT_DATA = '1.3.6.1.4.1.311.2.1.4';
const OID_RFC3161_COUNTER_SIGN = '1.3.6.1.4.1.311.3.3.1';
const OID_LEGACY_COUNTER_SIGN = '1.2.840.113549.1.9.6';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const SHA1_THUMBPRINT = /^[0-9a-fA-F]{40}$/;

const EXTRACT_NUPKG_TARGETS_PS = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$destRoot = [System.IO.Path]::GetFullPath($env:LUDY_UNZIP_DST)',
  'if (-not $destRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {',
  '  $destRoot += [System.IO.Path]::DirectorySeparatorChar',
  '}',
  '$maxEntries = 10000',
  '$maxBytes = 268435456L',
  '$zip = [System.IO.Compression.ZipFile]::OpenRead($env:LUDY_UNZIP_SRC)',
  'try {',
  '  $seenEntries = 0',
  '  $totalBytes = 0L',
  '  $buf = New-Object byte[] 65536',
  '  $targets = @{}',
  '  foreach ($entry in $zip.Entries) {',
  '    $seenEntries += 1',
  '    if ($seenEntries -gt $maxEntries) { throw "Update archive exceeded maximum zip entry limit ($maxEntries)" }',
  '    if ([string]::IsNullOrEmpty($entry.Name)) { continue }',
  '    $rel = $entry.FullName.Replace("\\", "/").TrimStart("/")',
  '    if ($rel -inotmatch "^lib/net45/(ludy-desktop\\.exe|squirrel\\.exe|resources/app\\.asar\\.unpacked/bin/ludy-wasapi-loopback\\.exe)$") {',
  '      continue',
  '    }',
  '    if ($entry.Length -lt 0 -or $entry.Length -gt $maxBytes) { throw "Update binary entry exceeds extracted size limit" }',
  '    $outPath = [System.IO.Path]::GetFullPath((Join-Path $destRoot $rel))',
  '    if (-not $outPath.StartsWith($destRoot, [System.StringComparison]::OrdinalIgnoreCase)) {',
  '      throw "Unsafe zip path: $($entry.FullName)"',
  '    }',
  '    $parent = [System.IO.Path]::GetDirectoryName($outPath)',
  '    if (-not (Test-Path -LiteralPath $parent)) { [void][System.IO.Directory]::CreateDirectory($parent) }',
  '    $inStream = $entry.Open()',
  '    try {',
  '      $outStream = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
  '      try {',
  '        for (;;) {',
  '          $n = $inStream.Read($buf, 0, $buf.Length)',
  '          if ($n -le 0) { break }',
  '          $totalBytes += $n',
  '          if ($totalBytes -gt $maxBytes) { throw "Extracted update binaries exceeded size limit ($maxBytes bytes)" }',
  '          $outStream.Write($buf, 0, $n)',
  '        }',
  '      } finally { $outStream.Dispose() }',
  '    } finally { $inStream.Dispose() }',
  '    $targets[$rel.ToLowerInvariant()] = $outPath',
  '  }',
  '  if ($targets.Count -ne 3) { throw "Update package is missing required signed binaries" }',
  '} finally {',
  '  $zip.Dispose()',
  '}',
].join('\n');

const CHECK_AUTHENTICODE_PS = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)',
  'try {',
  '  $rawInput = $reader.ReadToEnd()',
  '} finally { $reader.Dispose() }',
  '$files = ConvertFrom-Json -InputObject $rawInput',
  'if ($files -isnot [System.Array]) { $files = @($files) }',
  '$results = foreach ($file in $files) {',
  '  $sig = Get-AuthenticodeSignature -LiteralPath $file',
  '  [pscustomobject]@{',
  '    path = [string]$file',
  '    status = [string]$sig.Status',
  '    thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { $null }',
  '    hasTimestamp = ($null -ne $sig.TimeStamperCertificate)',
  '  }',
  '}',
  '$results | ConvertTo-Json -Compress',
].join('\n');

interface DerTlv {
  tag: number;
  contentStart: number;
  contentEnd: number;
  nextOffset: number;
}

function readDerTlv(buf: Buffer, offset: number): DerTlv {
  if (offset + 2 > buf.length) {
    throw new Error('Unexpected end of ASN.1 DER data');
  }
  const tag = buf.readUInt8(offset);
  const lenByte = buf.readUInt8(offset + 1);
  let headerBytes = 2;
  let contentLen = 0;
  if (lenByte < 0x80) {
    contentLen = lenByte;
  } else {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0 || numOctets > 4 || offset + 2 + numOctets > buf.length) {
      throw new Error('Invalid or indefinite ASN.1 DER length');
    }
    headerBytes = 2 + numOctets;
    for (let i = 0; i < numOctets; i++) {
      contentLen = contentLen * 256 + buf.readUInt8(offset + 2 + i);
    }
  }
  const contentStart = offset + headerBytes;
  const contentEnd = contentStart + contentLen;
  if (contentEnd > buf.length || contentLen < 0) {
    throw new Error('ASN.1 DER element extends past buffer end');
  }
  return { tag, contentStart, contentEnd, nextOffset: contentEnd };
}

function readDerChildren(buf: Buffer, start: number, end: number): DerTlv[] {
  const out: DerTlv[] = [];
  let cursor = start;
  while (cursor < end) {
    const tlv = readDerTlv(buf, cursor);
    if (tlv.nextOffset > end) {
      throw new Error('ASN.1 DER child extends past parent container');
    }
    out.push(tlv);
    cursor = tlv.nextOffset;
  }
  return out;
}

function decodeDerOid(buf: Buffer, tlv: DerTlv): string {
  if (tlv.tag !== 0x06 || tlv.contentStart >= tlv.contentEnd) {
    throw new Error('Expected ASN.1 OBJECT IDENTIFIER');
  }
  const first = buf.readUInt8(tlv.contentStart);
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  let hasBytes = false;
  for (let i = tlv.contentStart + 1; i < tlv.contentEnd; i++) {
    const byte = buf.readUInt8(i);
    hasBytes = true;
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error('ASN.1 OID arc overflow');
    }
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
      hasBytes = false;
    }
  }
  if (hasBytes) {
    throw new Error('Truncated ASN.1 OID VLQ');
  }
  return arcs.join('.');
}

export interface InspectedAuthenticodeCms {
  fileDigestOid: string;
  timestampType: 'rfc3161' | 'authenticode-legacy' | 'none';
  tsDigestOid: string | null;
}

function inspectRfc3161Token(buf: Buffer, tokenTlv: DerTlv): string {
  if (tokenTlv.tag !== 0x30) {
    throw new Error('RFC 3161 timestamp token is not a ContentInfo SEQUENCE');
  }
  const ci = readDerChildren(buf, tokenTlv.contentStart, tokenTlv.contentEnd);
  if (ci.length < 2 || decodeDerOid(buf, ci[0]!) !== OID_SIGNED_DATA || ci[1]!.tag !== 0xa0) {
    throw new Error('RFC 3161 timestamp token does not contain SignedData');
  }
  const signedData = readDerTlv(buf, ci[1]!.contentStart);
  if (signedData.tag !== 0x30) {
    throw new Error('Invalid SignedData inside RFC 3161 timestamp token');
  }
  const sdFields = readDerChildren(buf, signedData.contentStart, signedData.contentEnd);
  if (sdFields.length < 3 || sdFields[2]!.tag !== 0x30) {
    throw new Error('RFC 3161 SignedData missing encapContentInfo');
  }
  const encap = readDerChildren(buf, sdFields[2]!.contentStart, sdFields[2]!.contentEnd);
  if (encap.length < 2 || decodeDerOid(buf, encap[0]!) !== OID_TST_INFO || encap[1]!.tag !== 0xa0) {
    throw new Error('RFC 3161 encapContentInfo is not id-ct-TSTInfo');
  }
  const tstOctet = readDerTlv(buf, encap[1]!.contentStart);
  if (tstOctet.tag !== 0x04) {
    throw new Error('RFC 3161 TSTInfo wrapper is not an OCTET STRING');
  }
  const tstInfo = readDerTlv(buf, tstOctet.contentStart);
  if (tstInfo.tag !== 0x30 || tstInfo.contentEnd > tstOctet.contentEnd) {
    throw new Error('RFC 3161 TSTInfo is not a valid SEQUENCE');
  }
  const tstFields = readDerChildren(buf, tstInfo.contentStart, tstInfo.contentEnd);
  // TSTInfo ::= SEQUENCE { version INTEGER, policy OBJECT IDENTIFIER, messageImprint MessageImprint, ... }
  if (tstFields.length < 3 || tstFields[2]!.tag !== 0x30) {
    throw new Error('RFC 3161 TSTInfo missing messageImprint');
  }
  const msgImprint = readDerChildren(buf, tstFields[2]!.contentStart, tstFields[2]!.contentEnd);
  if (msgImprint.length < 2 || msgImprint[0]!.tag !== 0x30) {
    throw new Error('RFC 3161 messageImprint missing hashAlgorithm');
  }
  const hashAlg = readDerChildren(buf, msgImprint[0]!.contentStart, msgImprint[0]!.contentEnd);
  if (hashAlg.length < 1) {
    throw new Error('RFC 3161 messageImprint AlgorithmIdentifier is empty');
  }
  return decodeDerOid(buf, hashAlg[0]!);
}

export function inspectAuthenticodePkcs7Der(der: Buffer): InspectedAuthenticodeCms {
  const outer = readDerTlv(der, 0);
  if (outer.tag !== 0x30) {
    throw new Error('Authenticode CMS does not start with ContentInfo SEQUENCE');
  }
  const ci = readDerChildren(der, outer.contentStart, outer.contentEnd);
  if (ci.length < 2 || decodeDerOid(der, ci[0]!) !== OID_SIGNED_DATA || ci[1]!.tag !== 0xa0) {
    throw new Error('Authenticode CMS is not PKCS#7 SignedData');
  }
  const signedData = readDerTlv(der, ci[1]!.contentStart);
  if (signedData.tag !== 0x30) {
    throw new Error('Authenticode SignedData is not a SEQUENCE');
  }
  const sdFields = readDerChildren(der, signedData.contentStart, signedData.contentEnd);
  if (sdFields.length < 4 || sdFields[2]!.tag !== 0x30) {
    throw new Error('Authenticode SignedData missing encapContentInfo');
  }

  // Extract SpcIndirectDataContent.messageDigest.digestAlgorithm (the true /fd Authenticode file digest OID).
  const encap = readDerChildren(der, sdFields[2]!.contentStart, sdFields[2]!.contentEnd);
  if (encap.length < 2 || decodeDerOid(der, encap[0]!) !== OID_SPC_INDIRECT_DATA || encap[1]!.tag !== 0xa0) {
    throw new Error('Authenticode encapContentInfo does not hold SpcIndirectDataContent');
  }
  const spcIndirect = readDerTlv(der, encap[1]!.contentStart);
  if (spcIndirect.tag !== 0x30) {
    throw new Error('SpcIndirectDataContent is not a SEQUENCE');
  }
  const spcFields = readDerChildren(der, spcIndirect.contentStart, spcIndirect.contentEnd);
  if (spcFields.length < 2 || spcFields[1]!.tag !== 0x30) {
    throw new Error('SpcIndirectDataContent missing messageDigest DigestInfo');
  }
  const digestInfo = readDerChildren(der, spcFields[1]!.contentStart, spcFields[1]!.contentEnd);
  if (digestInfo.length < 2 || digestInfo[0]!.tag !== 0x30) {
    throw new Error('SpcIndirectDataContent DigestInfo missing digestAlgorithm');
  }
  const fileAlgFields = readDerChildren(der, digestInfo[0]!.contentStart, digestInfo[0]!.contentEnd);
  if (fileAlgFields.length < 1) {
    throw new Error('SpcIndirectDataContent digestAlgorithm AlgorithmIdentifier is empty');
  }
  const fileDigestOid = decodeDerOid(der, fileAlgFields[0]!);

  // Locate signerInfos SET at end of SignedData.
  let signerInfosSet: DerTlv | null = null;
  for (let i = 3; i < sdFields.length; i++) {
    if (sdFields[i]!.tag === 0x31) {
      signerInfosSet = sdFields[i]!;
    }
  }
  if (!signerInfosSet) {
    throw new Error('Authenticode SignedData missing signerInfos SET');
  }
  const signers = readDerChildren(der, signerInfosSet.contentStart, signerInfosSet.contentEnd);
  if (signers.length === 0 || signers[0]!.tag !== 0x30) {
    throw new Error('Authenticode signerInfos SET contains no SignerInfo');
  }
  const signerFields = readDerChildren(der, signers[0]!.contentStart, signers[0]!.contentEnd);
  const unsignedAttrs = signerFields.find((field) => field.tag === 0xa1);
  if (!unsignedAttrs) {
    return { fileDigestOid, timestampType: 'none', tsDigestOid: null };
  }
  const attrs = readDerChildren(der, unsignedAttrs.contentStart, unsignedAttrs.contentEnd);
  for (const attr of attrs) {
    if (attr.tag !== 0x30) continue;
    const parts = readDerChildren(der, attr.contentStart, attr.contentEnd);
    if (parts.length < 2) continue;
    const oid = decodeDerOid(der, parts[0]!);
    if (oid === OID_RFC3161_COUNTER_SIGN) {
      const valSet = parts[1]!;
      if (valSet.tag !== 0x31) {
        throw new Error('RFC 3161 unsigned attribute values must be a SET');
      }
      const tokens = readDerChildren(der, valSet.contentStart, valSet.contentEnd);
      if (tokens.length === 0) {
        throw new Error('RFC 3161 unsigned attribute has no timestamp token');
      }
      return {
        fileDigestOid,
        timestampType: 'rfc3161',
        tsDigestOid: inspectRfc3161Token(der, tokens[0]!),
      };
    }
    if (oid === OID_LEGACY_COUNTER_SIGN) {
      return { fileDigestOid, timestampType: 'authenticode-legacy', tsDigestOid: null };
    }
  }
  return { fileDigestOid, timestampType: 'none', tsDigestOid: null };
}

function trimAsn1SequencePadding(raw: Buffer): Buffer {
  const tlv = readDerTlv(raw, 0);
  if (tlv.tag !== 0x30 || tlv.nextOffset <= 2) {
    throw new Error('Embedded Authenticode PKCS#7 blob does not start with an ASN.1 SEQUENCE');
  }
  return raw.subarray(0, tlv.nextOffset);
}

export function extractEmbeddedPkcs7Der(filePath: string): Buffer {
  if (filePath.toLowerCase().endsWith('.ps1')) {
    const text = readFileSync(filePath, 'utf8');
    const beginMarker = '# SIG # Begin signature block';
    const endMarker = '# SIG # End signature block';
    const begin = text.indexOf(beginMarker);
    const end = text.indexOf(endMarker);
    if (begin === -1 || end === -1 || end <= begin) {
      throw new Error(`Signed manifest script ${filePath} has no Authenticode signature block`);
    }
    const body = text.slice(begin + beginMarker.length, end);
    const base64 = body
      .split(/\r?\n/)
      .map((line) => line.replace(/^#\s?/, '').trim())
      .filter(Boolean)
      .join('');
    if (!base64) {
      throw new Error(`Signed manifest script ${filePath} has an empty signature block`);
    }
    return trimAsn1SequencePadding(Buffer.from(base64, 'base64'));
  }

  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size < 128) {
    throw new Error(`File is too small to be a signed PE binary: ${filePath}`);
  }
  const fd = openSync(filePath, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, 64, 0) < 64 || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Invalid PE DOS header: ${filePath}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset + 256 > stat.size) {
      throw new Error(`Corrupt PE header offset: ${filePath}`);
    }
    const headers = Buffer.alloc(256);
    if (readSync(fd, headers, 0, 256, peOffset) < 168 || headers.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Invalid PE signature: ${filePath}`);
    }
    const optOffset = 24;
    const magic = headers.readUInt16LE(optOffset);
    let dataDirOffset: number;
    if (magic === 0x10b) {
      dataDirOffset = optOffset + 96;
    } else if (magic === 0x20b) {
      dataDirOffset = optOffset + 112;
    } else {
      throw new Error(`Unsupported PE optional header magic 0x${magic.toString(16)}: ${filePath}`);
    }
    const secDirOffset = dataDirOffset + 4 * 8;
    const secFileOffset = headers.readUInt32LE(secDirOffset);
    const secSize = headers.readUInt32LE(secDirOffset + 4);
    if (secFileOffset === 0 || secSize <= 8 || secFileOffset + secSize > stat.size) {
      throw new Error(`PE binary has no Authenticode security directory: ${filePath}`);
    }
    const certBuf = Buffer.alloc(secSize);
    if (readSync(fd, certBuf, 0, secSize, secFileOffset) < secSize) {
      throw new Error(`Failed reading WIN_CERTIFICATE record from ${filePath}`);
    }
    const dwLength = certBuf.readUInt32LE(0);
    const wRevision = certBuf.readUInt16LE(4);
    const wCertType = certBuf.readUInt16LE(6);
    if (wRevision !== 0x0200 || wCertType !== 0x0002 || dwLength <= 8 || dwLength > secSize) {
      throw new Error(`Unsupported WIN_CERTIFICATE entry in ${filePath}`);
    }
    return trimAsn1SequencePadding(certBuf.subarray(8, dwLength));
  } finally {
    closeSync(fd);
  }
}

export function formatSignedReleaseManifestScript(manifestJson: string): string {
  const normalized = `${JSON.stringify(JSON.parse(manifestJson))}`;
  return [
    '# LUDY_RELEASE_MANIFEST_V1',
    "$LudyReleaseManifestJson = @'",
    normalized,
    "'@",
    '',
  ].join('\r\n');
}

export function parseSignedReleaseManifestScript(scriptContent: string): Buffer {
  const sigIndex = scriptContent.indexOf('# SIG # Begin signature block');
  const unsignedPart = sigIndex === -1 ? scriptContent : scriptContent.slice(0, sigIndex);
  const match = /\$LudyReleaseManifestJson = @'\r?\n([^\r\n]+)\r?\n'@/.exec(unsignedPart);
  if (!match?.[1]) {
    throw new Error('Signed release manifest script does not contain expected JSON block');
  }
  return Buffer.from(match[1], 'utf8');
}

export function parseAuthenticodeCheckResults(
  jsonText: string,
  expectedPaths: readonly string[],
  expectedThumbprint?: string | null,
): { thumbprint: string } {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    throw new Error('Authenticode verification produced empty output');
  }
  if (expectedPaths.length === 0) {
    throw new Error('At least one file path is required for Authenticode verification');
  }
  const parsed: unknown = JSON.parse(jsonText);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== expectedPaths.length) {
    throw new Error(`Expected ${expectedPaths.length} Authenticode verification result(s), got ${rows.length}`);
  }
  let commonThumbprint: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const target = expectedPaths[i] ?? 'unknown file';
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Invalid Authenticode verification record for ${target}`);
    }
    const record = row as Record<string, unknown>;
    if (record.status !== 'Valid') {
      throw new Error(`Authenticode signature invalid for ${target}: status=${String(record.status)}`);
    }
    if (record.hasTimestamp !== true) {
      throw new Error(`Authenticode signature on ${target} is missing a timestamp`);
    }
    if (record.timestampType !== 'rfc3161') {
      throw new Error(`Authenticode signature on ${target} must use an RFC 3161 timestamp (got ${String(record.timestampType)})`);
    }
    if (record.fileDigestOid !== OID_SHA256) {
      throw new Error(`Authenticode signature on ${target} must use SHA-256 digest (got ${String(record.fileDigestOid)})`);
    }
    if (record.tsDigestOid !== OID_SHA256) {
      throw new Error(`RFC 3161 timestamp on ${target} must use SHA-256 digest (got ${String(record.tsDigestOid)})`);
    }
    if (typeof record.thumbprint !== 'string' || !SHA1_THUMBPRINT.test(record.thumbprint)) {
      throw new Error(`Authenticode signature on ${target} has invalid signer thumbprint`);
    }
    const thumb = record.thumbprint.toLowerCase();
    if (commonThumbprint === null) {
      commonThumbprint = thumb;
    } else if (commonThumbprint !== thumb) {
      throw new Error(`Signer thumbprint mismatch on ${target}: expected ${commonThumbprint}, got ${thumb}`);
    }
  }
  if (commonThumbprint === null) {
    throw new Error('No signer thumbprint returned from Authenticode verification');
  }
  if (expectedThumbprint) {
    const expected = expectedThumbprint.trim().toLowerCase();
    if (commonThumbprint !== expected) {
      throw new Error(`Signer thumbprint ${commonThumbprint} does not match expected ${expected}`);
    }
  }
  return { thumbprint: commonThumbprint };
}

function execPowerShellAsync(script: string, extraEnv: Record<string, string>, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`Authenticode PowerShell check failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdinText !== undefined && child.stdin) {
      child.stdin.end(stdinText, 'utf8');
    }
  });
}

export async function verifyWindowsAuthenticodeFiles(
  filePaths: readonly string[],
  expectedThumbprint: string | null = null,
  runPowerShell: (script: string, extraEnv: Record<string, string>, stdinText?: string) => Promise<string> = execPowerShellAsync,
  platform: string = process.platform,
): Promise<{ thumbprint: string }> {
  if (platform !== 'win32') {
    throw new Error('Windows Authenticode verification is only supported on Windows');
  }
  if (filePaths.length === 0) {
    throw new Error('At least one file path is required for Authenticode verification');
  }
  const inspectedCms = filePaths.map((filePath) => inspectAuthenticodePkcs7Der(extractEmbeddedPkcs7Der(filePath)));
  const stdout = await runPowerShell(CHECK_AUTHENTICODE_PS, {}, JSON.stringify(filePaths));
  const parsedRaw: unknown = JSON.parse(stdout);
  const rows: unknown[] = Array.isArray(parsedRaw) ? parsedRaw : [parsedRaw];
  if (rows.length !== filePaths.length) {
    throw new Error(`Expected ${filePaths.length} Authenticode verification result(s), got ${rows.length}`);
  }
  const mergedRows = rows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Invalid Authenticode verification record for ${filePaths[index] ?? 'unknown file'}`);
    }
    const cms = inspectedCms[index]!;
    return {
      ...(row as Record<string, unknown>),
      fileDigestOid: cms.fileDigestOid,
      timestampType: cms.timestampType,
      tsDigestOid: cms.tsDigestOid,
    };
  });
  return parseAuthenticodeCheckResults(JSON.stringify(mergedRows), filePaths, expectedThumbprint);
}

export async function verifyWindowsSignedManifest(
  manifestScriptPath: string,
  expectedJsonBytes: Buffer,
  expectedThumbprint: string,
  runPowerShell: (script: string, extraEnv: Record<string, string>, stdinText?: string) => Promise<string> = execPowerShellAsync,
  platform: string = process.platform,
): Promise<{ thumbprint: string }> {
  const verified = await verifyWindowsAuthenticodeFiles([manifestScriptPath], expectedThumbprint, runPowerShell, platform);
  const scriptContent = readFileSync(manifestScriptPath, 'utf8');
  const embeddedJson = parseSignedReleaseManifestScript(scriptContent);
  const expectedObj: unknown = JSON.parse(expectedJsonBytes.toString('utf8'));
  const embeddedObj: unknown = JSON.parse(embeddedJson.toString('utf8'));
  if (JSON.stringify(embeddedObj) !== JSON.stringify(expectedObj)) {
    throw new Error('Signed release manifest payload does not match release-manifest.json');
  }
  return verified;
}

function findFileCaseInsensitive(dir: string, expectedName: string): string | null {
  const lower = expectedName.toLowerCase();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === lower) {
      return join(dir, entry.name);
    }
  }
  return null;
}

export async function verifyWindowsSignedPackage(
  packagePath: string,
  expectedThumbprint: string | null,
  runPowerShell: (script: string, extraEnv: Record<string, string>, stdinText?: string) => Promise<string> = execPowerShellAsync,
  platform: string = process.platform,
): Promise<void> {
  if (platform !== 'win32') {
    throw new Error('Windows Authenticode verification is only supported on Windows');
  }
  const extractDir = mkdtempSync(join(dirname(packagePath), 'verify-nupkg-'));
  try {
    await runPowerShell(EXTRACT_NUPKG_TARGETS_PS, {
      LUDY_UNZIP_SRC: packagePath,
      LUDY_UNZIP_DST: extractDir,
    });
    const net45Dir = join(extractDir, 'lib', 'net45');
    if (!existsSync(net45Dir)) {
      throw new Error('Update package is missing lib/net45 directory');
    }
    const appExe = findFileCaseInsensitive(net45Dir, 'ludy-desktop.exe');
    const squirrelExe = findFileCaseInsensitive(net45Dir, 'squirrel.exe');
    const nativeExe = join(net45Dir, 'resources', 'app.asar.unpacked', 'bin', 'ludy-wasapi-loopback.exe');
    if (!appExe || !squirrelExe || !existsSync(nativeExe)) {
      throw new Error('Update package is missing required signed binaries');
    }
    await verifyWindowsAuthenticodeFiles([appExe, squirrelExe, nativeExe], expectedThumbprint, runPowerShell, platform);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
