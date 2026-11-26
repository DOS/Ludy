// SPDX-License-Identifier: AGPL-3.0-only
// Verifies Windows Authenticode signatures, SpcIndirectDataContent SHA-256 file digest (/fd), RFC 3161 TSTInfo
// messageImprint SHA-256 digest (/td), and signed release-manifest.ps1 scripts before Squirrel sees an update.
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
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
  '    $key = $rel.ToLowerInvariant()',
  '    if ($targets.ContainsKey($key)) { throw "Duplicate update binary entry in archive: $rel" }',
  '    $outPath = [System.IO.Path]::GetFullPath((Join-Path $destRoot $rel))',
  '    if (-not $outPath.StartsWith($destRoot, [System.StringComparison]::OrdinalIgnoreCase)) {',
  '      throw "Unsafe zip path: $($entry.FullName)"',
  '    }',
  '    $targets[$key] = $outPath',
  '    $parent = [System.IO.Path]::GetDirectoryName($outPath)',
  '    if (-not (Test-Path -LiteralPath $parent)) { [void][System.IO.Directory]::CreateDirectory($parent) }',
  '    $inStream = $entry.Open()',
  '    try {',
  '      $outStream = [System.IO.File]::Open($outPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
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
  '    signatureType = [string]$sig.SignatureType',
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
  signerDigestOid: string;
  timestampType: 'rfc3161' | 'authenticode-legacy' | 'none';
  tsDigestOid: string | null;
}

function unwrapExplicitSingleChild(buf: Buffer, wrapper: DerTlv, label: string): DerTlv {
  if (wrapper.tag !== 0xa0) {
    throw new Error(`${label} must be [0] EXPLICIT`);
  }
  const children = readDerChildren(buf, wrapper.contentStart, wrapper.contentEnd);
  if (children.length !== 1) {
    throw new Error(`${label} wrapper must contain exactly one ASN.1 DER element`);
  }
  return children[0]!;
}

function inspectRfc3161Token(buf: Buffer, tokenTlv: DerTlv, expectedSignatureSha256: Buffer): string {
  if (tokenTlv.tag !== 0x30) {
    throw new Error('RFC 3161 timestamp token is not a ContentInfo SEQUENCE');
  }
  const ci = readDerChildren(buf, tokenTlv.contentStart, tokenTlv.contentEnd);
  if (ci.length < 2 || decodeDerOid(buf, ci[0]!) !== OID_SIGNED_DATA) {
    throw new Error('RFC 3161 timestamp token does not contain SignedData');
  }
  const signedData = unwrapExplicitSingleChild(buf, ci[1]!, 'RFC 3161 SignedData');
  if (signedData.tag !== 0x30) {
    throw new Error('Invalid SignedData inside RFC 3161 timestamp token');
  }
  const sdFields = readDerChildren(buf, signedData.contentStart, signedData.contentEnd);
  if (sdFields.length < 3 || sdFields[2]!.tag !== 0x30) {
    throw new Error('RFC 3161 SignedData missing encapContentInfo');
  }
  const encap = readDerChildren(buf, sdFields[2]!.contentStart, sdFields[2]!.contentEnd);
  if (encap.length < 2 || decodeDerOid(buf, encap[0]!) !== OID_TST_INFO) {
    throw new Error('RFC 3161 encapContentInfo is not id-ct-TSTInfo');
  }
  const tstOctet = unwrapExplicitSingleChild(buf, encap[1]!, 'RFC 3161 TSTInfo octet wrapper');
  if (tstOctet.tag !== 0x04) {
    throw new Error('RFC 3161 TSTInfo wrapper is not an OCTET STRING');
  }
  const tstInner = readDerChildren(buf, tstOctet.contentStart, tstOctet.contentEnd);
  if (tstInner.length !== 1 || tstInner[0]!.tag !== 0x30) {
    throw new Error('RFC 3161 TSTInfo is not a valid single SEQUENCE');
  }
  const tstInfo = tstInner[0]!;
  const tstFields = readDerChildren(buf, tstInfo.contentStart, tstInfo.contentEnd);
  // TSTInfo ::= SEQUENCE { version INTEGER, policy OBJECT IDENTIFIER, messageImprint MessageImprint, ... }
  if (tstFields.length < 3 || tstFields[2]!.tag !== 0x30) {
    throw new Error('RFC 3161 TSTInfo missing messageImprint');
  }
  const msgImprint = readDerChildren(buf, tstFields[2]!.contentStart, tstFields[2]!.contentEnd);
  if (msgImprint.length !== 2 || msgImprint[0]!.tag !== 0x30 || msgImprint[1]!.tag !== 0x04) {
    throw new Error('RFC 3161 messageImprint must contain hashAlgorithm and hashedMessage OCTET STRING');
  }
  const hashAlg = readDerChildren(buf, msgImprint[0]!.contentStart, msgImprint[0]!.contentEnd);
  if (hashAlg.length < 1) {
    throw new Error('RFC 3161 messageImprint AlgorithmIdentifier is empty');
  }
  const imprintBytes = buf.subarray(msgImprint[1]!.contentStart, msgImprint[1]!.contentEnd);
  if (imprintBytes.length !== expectedSignatureSha256.length || !timingSafeEqual(imprintBytes, expectedSignatureSha256)) {
    throw new Error('RFC 3161 TSTInfo messageImprint digest does not match SignerInfo signature');
  }
  return decodeDerOid(buf, hashAlg[0]!);
}

function parseRfc5652SignerInfo(
  der: Buffer,
  signerTlv: DerTlv,
): { signerDigestOid: string; encryptedDigest: Buffer; unsignedAttrs: DerTlv | null } {
  const fields = readDerChildren(der, signerTlv.contentStart, signerTlv.contentEnd);
  // version (0x02), sid (0x30 | 0x80), digestAlgorithm (0x30)
  if (fields.length < 5 || fields[0]!.tag !== 0x02 || (fields[1]!.tag !== 0x30 && fields[1]!.tag !== 0x80) || fields[2]!.tag !== 0x30) {
    throw new Error('Invalid RFC 5652 SignerInfo header fields');
  }
  const digestAlgFields = readDerChildren(der, fields[2]!.contentStart, fields[2]!.contentEnd);
  if (digestAlgFields.length < 1) {
    throw new Error('SignerInfo digestAlgorithm AlgorithmIdentifier is empty');
  }
  const signerDigestOid = decodeDerOid(der, digestAlgFields[0]!);

  let idx = 3;
  if (fields[idx]?.tag === 0xa0) {
    idx += 1;
  }
  const sigAlg = fields[idx];
  const sigVal = fields[idx + 1];
  if (!sigAlg || sigAlg.tag !== 0x30 || !sigVal || sigVal.tag !== 0x04) {
    throw new Error('SignerInfo missing signatureAlgorithm or encryptedDigest OCTET STRING');
  }
  const encryptedDigest = der.subarray(sigVal.contentStart, sigVal.contentEnd);
  let unsignedAttrs: DerTlv | null = null;
  if (idx + 2 < fields.length) {
    if (idx + 3 !== fields.length || fields[idx + 2]!.tag !== 0xa1) {
      throw new Error('SignerInfo contains invalid trailing or duplicate unsignedAttrs');
    }
    unsignedAttrs = fields[idx + 2]!;
  }
  return { signerDigestOid, encryptedDigest, unsignedAttrs };
}

export function inspectAuthenticodePkcs7Der(der: Buffer): InspectedAuthenticodeCms {
  const outer = readDerTlv(der, 0);
  if (outer.tag !== 0x30 || outer.nextOffset !== der.length) {
    throw new Error('Authenticode CMS must contain a single outer ContentInfo SEQUENCE');
  }
  const ci = readDerChildren(der, outer.contentStart, outer.contentEnd);
  if (ci.length < 2 || decodeDerOid(der, ci[0]!) !== OID_SIGNED_DATA) {
    throw new Error('Authenticode CMS is not PKCS#7 SignedData');
  }
  const signedData = unwrapExplicitSingleChild(der, ci[1]!, 'Authenticode SignedData');
  if (signedData.tag !== 0x30) {
    throw new Error('Authenticode SignedData is not a SEQUENCE');
  }
  const sdFields = readDerChildren(der, signedData.contentStart, signedData.contentEnd);
  if (sdFields.length < 4 || sdFields[2]!.tag !== 0x30) {
    throw new Error('Authenticode SignedData missing encapContentInfo');
  }

  // Extract SpcIndirectDataContent.messageDigest.digestAlgorithm (the true /fd Authenticode file digest OID).
  const encap = readDerChildren(der, sdFields[2]!.contentStart, sdFields[2]!.contentEnd);
  if (encap.length < 2 || decodeDerOid(der, encap[0]!) !== OID_SPC_INDIRECT_DATA) {
    throw new Error('Authenticode encapContentInfo does not hold SpcIndirectDataContent');
  }
  const spcIndirect = unwrapExplicitSingleChild(der, encap[1]!, 'Authenticode SpcIndirectDataContent');
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
  if (signers.length !== 1 || signers[0]!.tag !== 0x30) {
    throw new Error(`Authenticode signerInfos SET must contain exactly one SignerInfo (got ${signers.length})`);
  }
  const { signerDigestOid, encryptedDigest, unsignedAttrs } = parseRfc5652SignerInfo(der, signers[0]!);
  if (!unsignedAttrs) {
    return { fileDigestOid, signerDigestOid, timestampType: 'none', tsDigestOid: null };
  }

  const expectedSignatureSha256 = createHash('sha256').update(encryptedDigest).digest();
  const attrs = readDerChildren(der, unsignedAttrs.contentStart, unsignedAttrs.contentEnd);
  let rfc3161TsDigestOid: string | null = null;
  let rfc3161Count = 0;
  let hasLegacyCounterSign = false;

  for (const attr of attrs) {
    if (attr.tag !== 0x30) {
      throw new Error('Invalid Attribute TLV inside SignerInfo unsignedAttrs');
    }
    const parts = readDerChildren(der, attr.contentStart, attr.contentEnd);
    if (parts.length !== 2) {
      throw new Error('Invalid Attribute structure inside SignerInfo unsignedAttrs');
    }
    const oid = decodeDerOid(der, parts[0]!);
    if (oid === OID_RFC3161_COUNTER_SIGN) {
      rfc3161Count += 1;
      if (rfc3161Count > 1) {
        throw new Error('Duplicate RFC 3161 timestamp attributes in Authenticode SignerInfo');
      }
      const valSet = parts[1]!;
      if (valSet.tag !== 0x31) {
        throw new Error('RFC 3161 unsigned attribute values must be a SET');
      }
      const tokens = readDerChildren(der, valSet.contentStart, valSet.contentEnd);
      if (tokens.length !== 1) {
        throw new Error(`RFC 3161 unsigned attribute must contain exactly one timestamp token (got ${tokens.length})`);
      }
      rfc3161TsDigestOid = inspectRfc3161Token(der, tokens[0]!, expectedSignatureSha256);
    } else if (oid === OID_LEGACY_COUNTER_SIGN) {
      hasLegacyCounterSign = true;
    }
  }

  if (hasLegacyCounterSign) {
    return { fileDigestOid, signerDigestOid, timestampType: 'authenticode-legacy', tsDigestOid: null };
  }
  if (rfc3161Count === 1) {
    return { fileDigestOid, signerDigestOid, timestampType: 'rfc3161', tsDigestOid: rfc3161TsDigestOid };
  }
  return { fileDigestOid, signerDigestOid, timestampType: 'none', tsDigestOid: null };
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
    if (text.indexOf(beginMarker, begin + beginMarker.length) !== -1 || text.indexOf(endMarker, end + endMarker.length) !== -1) {
      throw new Error(`Signed manifest script ${filePath} contains duplicate signature block markers`);
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
    if (peOffset + 176 > stat.size) {
      throw new Error(`Corrupt PE header offset: ${filePath}`);
    }
    const headers = Buffer.alloc(256);
    if (readSync(fd, headers, 0, 256, peOffset) < 176 || headers.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Invalid PE signature: ${filePath}`);
    }
    const optOffset = 24;
    const magic = headers.readUInt16LE(optOffset);
    let dataDirOffset: number;
    let rvaCountOffset: number;
    if (magic === 0x10b) {
      rvaCountOffset = optOffset + 92;
      dataDirOffset = optOffset + 96;
    } else if (magic === 0x20b) {
      rvaCountOffset = optOffset + 108;
      dataDirOffset = optOffset + 112;
    } else {
      throw new Error(`Unsupported PE optional header magic 0x${magic.toString(16)}: ${filePath}`);
    }
    const numberOfRvaAndSizes = headers.readUInt32LE(rvaCountOffset);
    if (numberOfRvaAndSizes <= 4) {
      throw new Error(`PE binary lacks DataDirectory entry 4 for Authenticode: ${filePath}`);
    }
    const secDirOffset = dataDirOffset + 4 * 8;
    const secFileOffset = headers.readUInt32LE(secDirOffset);
    const secSize = headers.readUInt32LE(secDirOffset + 4);
    const MAX_WIN_CERT_BYTES = 16 * 1024 * 1024;
    if (secFileOffset === 0 || secSize <= 8 || secSize > MAX_WIN_CERT_BYTES || secFileOffset + secSize > stat.size) {
      throw new Error(`PE binary has invalid or missing Authenticode security directory: ${filePath}`);
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
  const beginMarker = '# SIG # Begin signature block';
  const endMarker = '# SIG # End signature block';
  const sigIndex = scriptContent.indexOf(beginMarker);
  if (sigIndex !== -1 && scriptContent.indexOf(beginMarker, sigIndex + beginMarker.length) !== -1) {
    throw new Error('Signed release manifest script contains duplicate signature block markers');
  }
  const endIndex = scriptContent.indexOf(endMarker);
  if (endIndex !== -1 && scriptContent.indexOf(endMarker, endIndex + endMarker.length) !== -1) {
    throw new Error('Signed release manifest script contains duplicate end signature block markers');
  }
  const unsignedPart = sigIndex === -1 ? scriptContent : scriptContent.slice(0, sigIndex);
  const matches = [...unsignedPart.matchAll(/\$LudyReleaseManifestJson = @'\r?\n([^\r\n]+)\r?\n'@/g)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error('Signed release manifest script must contain exactly one JSON payload block');
  }
  return Buffer.from(matches[0][1], 'utf8');
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
    if (record.signatureType !== undefined && record.signatureType !== 'Embedded') {
      throw new Error(`Authenticode check on ${target} must verify an embedded signature (got ${String(record.signatureType)})`);
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
    if (record.signerDigestOid !== undefined && record.signerDigestOid !== OID_SHA256) {
      throw new Error(`Authenticode SignerInfo on ${target} must use SHA-256 digest (got ${String(record.signerDigestOid)})`);
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

export function resolveSystemPowerShellPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim() || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function execPowerShellAsync(script: string, extraEnv: Record<string, string>, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveSystemPowerShellPath(),
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
      signerDigestOid: cms.signerDigestOid,
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
