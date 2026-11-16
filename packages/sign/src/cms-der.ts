// SPDX-License-Identifier: AGPL-3.0-only
// Pure ASN.1 DER CMS ContentInfo(SignedData) inspector, CAdES-BES signedAttrs preparer,
// and detached RFC 5652 assembler for remote CA raw digest signatures + X.509 certificate chains.
import { X509Certificate, createHash } from 'node:crypto';
import { decodeBase64Bytes, isValidDerSequence, readText } from './http.ts';
import { CaProviderError } from './port.ts';

// OIDs: signedData (1.2.840.113549.1.7.2), data (1.2.840.113549.1.7.1),
// sha256 (2.16.840.1.101.3.4.2.1), sha256WithRSAEncryption (1.2.840.113549.1.1.11),
// id-ecPublicKey (1.2.840.10045.2.1), ecdsa-with-SHA256 (1.2.840.10045.4.3.2),
// contentType (1.2.840.113549.1.9.3), messageDigest (1.2.840.113549.1.9.4),
// signingTime (1.2.840.113549.1.9.5), signingCertificateV2 (1.2.840.113549.1.9.16.2.47).
const OID_SIGNED_DATA = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
const OID_DATA = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
const OID_SHA256 = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const OID_RSA_SHA256 = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
const OID_EC_PUBLIC_KEY = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_ECDSA_SHA256 = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const OID_CONTENT_TYPE = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03]);
const OID_MESSAGE_DIGEST = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]);
const OID_SIGNING_TIME = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x05]);
const OID_SIGNING_CERT = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x0c]);
const OID_SIGNING_CERT_V2 = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x2f]);
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

interface DerTlv {
  readonly tag: number;
  readonly offset: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly tlvEnd: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derNode(tag: number, content: Uint8Array): Uint8Array {
  const len = encodeDerLength(content.byteLength);
  const out = new Uint8Array(1 + len.byteLength + content.byteLength);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.byteLength);
  return out;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const derSeq = (...items: readonly Uint8Array[]) => derNode(0x30, concatBytes(...items));
const derSet = (...items: readonly Uint8Array[]) => derNode(0x31, concatBytes(...items));
const derOid = (oid: Uint8Array) => derNode(0x06, oid);
const derInt = (val: number) => derNode(0x02, new Uint8Array([val]));
const derTagged0 = (inner: Uint8Array) => derNode(0xa0, inner);

function readDerTlv(bytes: Uint8Array, offset: number): DerTlv | null {
  if (offset < 0 || offset >= bytes.byteLength) return null;
  const tag = bytes[offset];
  const lenByte = bytes[offset + 1];
  if (tag === undefined || lenByte === undefined || (tag & 0x1f) === 0x1f) return null;
  let headerLen: number;
  let len: number;
  if (lenByte < 0x80) {
    headerLen = 2;
    len = lenByte;
  } else {
    const octets = lenByte & 0x7f;
    if (octets === 0 || octets > 4 || offset + 2 + octets > bytes.byteLength) return null;
    if (bytes[offset + 2] === 0x00) return null;
    len = 0;
    for (let i = 0; i < octets; i += 1) {
      const b = bytes[offset + 2 + i];
      if (b === undefined) return null;
      len = len * 256 + b;
    }
    if (len < 0x80) return null;
    headerLen = 2 + octets;
  }
  const valueStart = offset + headerLen;
  const valueEnd = valueStart + len;
  if (valueEnd > bytes.byteLength) return null;
  return { tag, offset, valueStart, valueEnd, tlvEnd: valueEnd };
}

export function isCmsSignedDataDer(bytes: Uint8Array): boolean {
  if (!isValidDerSequence(bytes)) return false;
  const outer = readDerTlv(bytes, 0);
  if (!outer || outer.tag !== 0x30 || outer.tlvEnd !== bytes.byteLength) return false;
  const first = readDerTlv(bytes, outer.valueStart);
  if (!first || first.tag !== 0x06) return false;
  return bytesEqual(bytes.subarray(first.valueStart, first.valueEnd), OID_SIGNED_DATA);
}

function inspectCmsSignedAttrs(bytes: Uint8Array, requireCadesAttributes: boolean): boolean {
  if (!isCmsSignedDataDer(bytes)) return false;
  const outer = readDerTlv(bytes, 0);
  if (!outer) return false;
  const oid = readDerTlv(bytes, outer.valueStart);
  if (!oid) return false;
  const contentWrapper = readDerTlv(bytes, oid.tlvEnd);
  if (!contentWrapper || contentWrapper.tag !== 0xa0 || contentWrapper.tlvEnd !== outer.valueEnd) return false;
  const signedData = readDerTlv(bytes, contentWrapper.valueStart);
  if (!signedData || signedData.tag !== 0x30 || signedData.tlvEnd !== contentWrapper.valueEnd) return false;

  const version = readDerTlv(bytes, signedData.valueStart);
  if (!version || version.tag !== 0x02) return false;
  const digestAlgs = readDerTlv(bytes, version.tlvEnd);
  if (!digestAlgs || digestAlgs.tag !== 0x31) return false;
  const encap = readDerTlv(bytes, digestAlgs.tlvEnd);
  if (!encap || encap.tag !== 0x30) return false;

  let pos = encap.tlvEnd;
  let next = readDerTlv(bytes, pos);
  if (next && next.tag === 0xa0) {
    pos = next.tlvEnd;
    next = readDerTlv(bytes, pos);
  }
  if (next && next.tag === 0xa1) {
    pos = next.tlvEnd;
    next = readDerTlv(bytes, pos);
  }
  if (!next || next.tag !== 0x31 || next.tlvEnd !== signedData.valueEnd) return false;

  let siPos = next.valueStart;
  let signerCount = 0;
  while (siPos < next.valueEnd) {
    const signerInfo = readDerTlv(bytes, siPos);
    if (!signerInfo || signerInfo.tag !== 0x30 || signerInfo.tlvEnd > next.valueEnd) return false;
    signerCount += 1;

    const siVersion = readDerTlv(bytes, signerInfo.valueStart);
    if (!siVersion || siVersion.tag !== 0x02) return false;
    const sid = readDerTlv(bytes, siVersion.tlvEnd);
    if (!sid || (sid.tag !== 0x30 && sid.tag !== 0x80)) return false;
    const siDigestAlg = readDerTlv(bytes, sid.tlvEnd);
    if (!siDigestAlg || siDigestAlg.tag !== 0x30) return false;
    const maybeAttrs = readDerTlv(bytes, siDigestAlg.tlvEnd);
    if (!maybeAttrs || maybeAttrs.tag !== 0xa0 || maybeAttrs.valueStart >= maybeAttrs.valueEnd) return false;

    const siSigAlg = readDerTlv(bytes, maybeAttrs.tlvEnd);
    if (!siSigAlg || siSigAlg.tag !== 0x30) return false;
    const siSig = readDerTlv(bytes, siSigAlg.tlvEnd);
    if (!siSig || siSig.tag !== 0x04 || siSig.valueStart >= siSig.valueEnd) return false;

    if (requireCadesAttributes) {
      let hasContentType = false;
      let hasMessageDigest = false;
      let hasSigningCert = false;
      let attrPos = maybeAttrs.valueStart;
      while (attrPos < maybeAttrs.valueEnd) {
        const attr = readDerTlv(bytes, attrPos);
        if (!attr || attr.tag !== 0x30 || attr.tlvEnd > maybeAttrs.valueEnd) return false;
        const attrType = readDerTlv(bytes, attr.valueStart);
        if (!attrType || attrType.tag !== 0x06) return false;
        const attrValues = readDerTlv(bytes, attrType.tlvEnd);
        if (!attrValues || attrValues.tag !== 0x31 || attrValues.valueStart >= attrValues.valueEnd || attrValues.tlvEnd !== attr.tlvEnd) {
          return false;
        }
        const firstVal = readDerTlv(bytes, attrValues.valueStart);
        if (!firstVal || firstVal.tlvEnd > attrValues.valueEnd) return false;
        const attrOid = bytes.subarray(attrType.valueStart, attrType.valueEnd);
        if (bytesEqual(attrOid, OID_CONTENT_TYPE) && firstVal.tag === 0x06) hasContentType = true;
        else if (bytesEqual(attrOid, OID_MESSAGE_DIGEST) && firstVal.tag === 0x04) hasMessageDigest = true;
        else if ((bytesEqual(attrOid, OID_SIGNING_CERT) || bytesEqual(attrOid, OID_SIGNING_CERT_V2)) && firstVal.tag === 0x30) {
          hasSigningCert = true;
        }
        attrPos = attr.tlvEnd;
      }
      if (!hasContentType || !hasMessageDigest || !hasSigningCert) return false;
    }
    siPos = signerInfo.tlvEnd;
  }
  return signerCount > 0 && siPos === next.valueEnd;
}

export function cmsHasSignedAttrs(bytes: Uint8Array): boolean {
  return inspectCmsSignedAttrs(bytes, false);
}

export function cmsHasCadesSignedAttrs(bytes: Uint8Array): boolean {
  return inspectCmsSignedAttrs(bytes, true);
}

export function decodeDerCertificate(value: unknown): Uint8Array | null {
  const raw = readText(value);
  if (!raw) return null;
  const stripped = raw
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '');
  const bytes = decodeBase64Bytes(stripped);
  if (!bytes || !isValidDerSequence(bytes)) return null;
  try {
    new X509Certificate(bytes);
    return bytes;
  } catch {
    return null;
  }
}

export function derCertToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function extractLeafSignerMeta(leafCertDer: Uint8Array): {
  readonly issuerTlv: Uint8Array;
  readonly serialTlv: Uint8Array;
  readonly keyKind: 'rsa' | 'ecdsa';
} | null {
  try {
    new X509Certificate(leafCertDer);
  } catch {
    return null;
  }
  const outer = readDerTlv(leafCertDer, 0);
  if (!outer || outer.tag !== 0x30 || outer.tlvEnd !== leafCertDer.byteLength) return null;
  const tbs = readDerTlv(leafCertDer, outer.valueStart);
  if (!tbs || tbs.tag !== 0x30) return null;

  let pos = tbs.valueStart;
  let field = readDerTlv(leafCertDer, pos);
  if (!field) return null;
  if (field.tag === 0xa0) {
    pos = field.tlvEnd;
    field = readDerTlv(leafCertDer, pos);
  }
  if (!field || field.tag !== 0x02) return null;
  const serialTlv = leafCertDer.subarray(field.offset, field.tlvEnd);

  const tbsSigAlg = readDerTlv(leafCertDer, field.tlvEnd);
  if (!tbsSigAlg || tbsSigAlg.tag !== 0x30) return null;

  const issuer = readDerTlv(leafCertDer, tbsSigAlg.tlvEnd);
  if (!issuer || issuer.tag !== 0x30) return null;
  const issuerTlv = leafCertDer.subarray(issuer.offset, issuer.tlvEnd);

  const validity = readDerTlv(leafCertDer, issuer.tlvEnd);
  if (!validity || validity.tag !== 0x30) return null;
  const subject = readDerTlv(leafCertDer, validity.tlvEnd);
  if (!subject || subject.tag !== 0x30) return null;
  const spki = readDerTlv(leafCertDer, subject.tlvEnd);
  if (!spki || spki.tag !== 0x30 || spki.tlvEnd > tbs.valueEnd) return null;

  let keyKind: 'rsa' | 'ecdsa' = 'rsa';
  const spkiAlg = readDerTlv(leafCertDer, spki.valueStart);
  if (spkiAlg && spkiAlg.tag === 0x30) {
    const spkiOid = readDerTlv(leafCertDer, spkiAlg.valueStart);
    if (spkiOid && spkiOid.tag === 0x06) {
      if (bytesEqual(leafCertDer.subarray(spkiOid.valueStart, spkiOid.valueEnd), OID_EC_PUBLIC_KEY)) {
        keyKind = 'ecdsa';
      }
    }
  }
  return { issuerTlv, serialTlv, keyKind };
}

function encodeUtcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return Buffer.from(`${yy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii');
}

function buildSignedAttrsDer(options: {
  readonly digestSha256: string;
  readonly certificateChainDer: readonly Uint8Array[];
  readonly signingTime?: Date;
  readonly includeSigningTime: boolean;
}): {
  readonly signedAttrsDer: Uint8Array;
  readonly signedAttrsSetSha256: string;
} {
  if (!SHA256_HEX_RE.test(options.digestSha256)) {
    throw new CaProviderError('invalid_request', 'digestSha256 must be a 64-character hex SHA-256 digest');
  }
  const leafCert = options.certificateChainDer[0];
  if (!leafCert) {
    throw new CaProviderError('invalid_request', 'leaf X.509 certificate DER is required for CAdES signedAttrs');
  }
  const meta = extractLeafSignerMeta(leafCert);
  if (!meta) {
    throw new CaProviderError('invalid_request', 'invalid X.509 certificate DER for CAdES signedAttrs');
  }
  const certHash = new Uint8Array(createHash('sha256').update(leafCert).digest());
  const docDigest = new Uint8Array(Buffer.from(options.digestSha256, 'hex'));

  const contentTypeAttr = derSeq(derOid(OID_CONTENT_TYPE), derSet(derOid(OID_DATA)));
  const messageDigestAttr = derSeq(derOid(OID_MESSAGE_DIGEST), derSet(derNode(0x04, docDigest)));
  const issuerSerial = derSeq(derSeq(derNode(0xa4, meta.issuerTlv)), meta.serialTlv);
  const essCertIdV2 = derSeq(derNode(0x04, certHash), issuerSerial);
  const signingCertV2Attr = derSeq(
    derOid(OID_SIGNING_CERT_V2),
    derSet(derSeq(derSeq(essCertIdV2))),
  );
  const attrs = [contentTypeAttr, messageDigestAttr, signingCertV2Attr];
  if (options.includeSigningTime) {
    attrs.push(
      derSeq(
        derOid(OID_SIGNING_TIME),
        derSet(derNode(0x17, encodeUtcTime(options.signingTime ?? new Date()))),
      ),
    );
  }

  // X.690 section 11.6 requires SET OF DER components to be sorted in ascending octet order.
  attrs.sort((a, b) => Buffer.compare(a, b));
  const body = concatBytes(...attrs);
  const canonicalSetDer = derNode(0x31, body);
  const signedAttrsDer = derNode(0xa0, body);
  const signedAttrsSetSha256 = createHash('sha256').update(canonicalSetDer).digest('hex');
  return { signedAttrsDer, signedAttrsSetSha256 };
}

// Prepares PAdES baseline signed attributes (ETSI EN 319 142-1 section 6.3 Table 1):
// contentType, messageDigest, and signingCertificateV2, omitting signing-time (PDF /M carries claimed time).
export function preparePadesSignedAttrs(options: {
  readonly digestSha256: string;
  readonly certificateChainDer: readonly Uint8Array[];
}): {
  readonly signedAttrsDer: Uint8Array;
  readonly signedAttrsSetSha256: string;
} {
  return buildSignedAttrsDer({
    digestSha256: options.digestSha256,
    certificateChainDer: options.certificateChainDer,
    includeSigningTime: false,
  });
}

// Prepares RFC 5652 / ETSI EN 319 122 CAdES-BES signed attributes (contentType, messageDigest,
// signingCertificateV2, and optional signingTime) and returns the SHA-256 hex digest of DER(SET OF Attribute).
export function prepareCadesSignedAttrs(options: {
  readonly digestSha256: string;
  readonly certificateChainDer: readonly Uint8Array[];
  readonly signingTime?: Date;
  readonly includeSigningTime?: boolean;
}): {
  readonly signedAttrsDer: Uint8Array;
  readonly signedAttrsSetSha256: string;
} {
  return buildSignedAttrsDer({
    digestSha256: options.digestSha256,
    certificateChainDer: options.certificateChainDer,
    ...(options.signingTime !== undefined ? { signingTime: options.signingTime } : {}),
    includeSigningTime: options.includeSigningTime ?? true,
  });
}

export function assembleDetachedCmsSignedData(options: {
  readonly rawSignature: Uint8Array;
  readonly certificateChainDer: readonly Uint8Array[];
  readonly signedAttrsDer?: Uint8Array;
}): Uint8Array | null {
  const { rawSignature, certificateChainDer, signedAttrsDer } = options;
  if (rawSignature.byteLength < 32 || rawSignature.byteLength > 4096 || certificateChainDer.length === 0) {
    return null;
  }
  if (signedAttrsDer !== undefined) {
    const attrsTlv = readDerTlv(signedAttrsDer, 0);
    if (!attrsTlv || attrsTlv.tag !== 0xa0 || attrsTlv.tlvEnd !== signedAttrsDer.byteLength) {
      return null;
    }
  }
  const leafCert = certificateChainDer[0];
  if (!leafCert) return null;
  const meta = extractLeafSignerMeta(leafCert);
  if (!meta) return null;
  for (const cert of certificateChainDer) {
    if (!isValidDerSequence(cert)) return null;
  }

  const sha256Alg = derSeq(derOid(OID_SHA256), derNode(0x05, new Uint8Array(0)));
  const sigAlg =
    meta.keyKind === 'ecdsa'
      ? derSeq(derOid(OID_ECDSA_SHA256))
      : derSeq(derOid(OID_RSA_SHA256), derNode(0x05, new Uint8Array(0)));

  const signerInfo = signedAttrsDer
    ? derSeq(
        derInt(1),
        derSeq(meta.issuerTlv, meta.serialTlv),
        sha256Alg,
        signedAttrsDer,
        sigAlg,
        derNode(0x04, rawSignature),
      )
    : derSeq(
        derInt(1),
        derSeq(meta.issuerTlv, meta.serialTlv),
        sha256Alg,
        sigAlg,
        derNode(0x04, rawSignature),
      );
  const sortedCerts = [...certificateChainDer].sort((a, b) => Buffer.compare(a, b));
  const uniqueCerts = sortedCerts.filter((cert, idx) => idx === 0 || Buffer.compare(cert, sortedCerts[idx - 1]!) !== 0);
  const certsField = derNode(0xa0, concatBytes(...uniqueCerts));
  const signedData = derSeq(
    derInt(1),
    derSet(sha256Alg),
    derSeq(derOid(OID_DATA)),
    certsField,
    derSet(signerInfo),
  );
  return derSeq(derOid(OID_SIGNED_DATA), derTagged0(signedData));
}

export interface RemoteCertSelectionRecord {
  readonly certRef: string | null;
  readonly isUsbOnly: boolean;
  readonly isActive: boolean;
  readonly chainDer: readonly Uint8Array[];
}

export function selectRemoteCertificateChain(options: {
  readonly providerLabel: string;
  readonly records: readonly RemoteCertSelectionRecord[];
  readonly wantedCertRef?: string;
}): readonly Uint8Array[] {
  const { providerLabel, records, wantedCertRef } = options;
  const activeRemote = records.filter((r) => !r.isUsbOnly && r.isActive && r.chainDer.length > 0);
  const eligible = activeRemote.length > 0 ? activeRemote : records.filter((r) => !r.isUsbOnly && r.chainDer.length > 0);
  if (eligible.length === 0) {
    throw new CaProviderError('unavailable', `${providerLabel} did not return a usable remote signing certificate`);
  }
  if (wantedCertRef !== undefined && wantedCertRef.trim() !== '') {
    const wanted = wantedCertRef.trim().toLowerCase();
    const match = eligible.find((r) => r.certRef?.toLowerCase() === wanted);
    if (!match) {
      throw new CaProviderError('unavailable', `${providerLabel} certificate matching transaction was not found`);
    }
    return match.chainDer;
  }
  if (eligible.length > 1) {
    throw new CaProviderError(
      'unavailable',
      `${providerLabel} account has multiple active certificates; pass certRef to fetchSignedCms after restart`,
    );
  }
  return eligible[0]!.chainDer;
}

export async function resolveCmsOrWrapRawSignature(options: {
  readonly providerLabel: string;
  readonly sigBytes: Uint8Array;
  readonly rawChain: unknown;
  readonly inlineChainDer: readonly Uint8Array[];
  readonly signedAttrsDer?: Uint8Array;
  readonly loadChainDer: () => Promise<readonly Uint8Array[]>;
}): Promise<{
  readonly cmsDer: Uint8Array;
  readonly subFilter: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
  readonly certificateChainPem: string[];
}> {
  const { providerLabel, sigBytes, rawChain, inlineChainDer, signedAttrsDer, loadChainDer } = options;
  if (isCmsSignedDataDer(sigBytes)) {
    const certificateChainPem =
      inlineChainDer.length > 0
        ? inlineChainDer.map(derCertToPem)
        : Array.isArray(rawChain)
          ? rawChain.map(readText).filter((v): v is string => v !== null)
          : [];
    return {
      cmsDer: sigBytes,
      subFilter: cmsHasCadesSignedAttrs(sigBytes) ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.detached',
      certificateChainPem,
    };
  }
  const chainDer = inlineChainDer.length > 0 ? inlineChainDer : await loadChainDer();
  const assembled = assembleDetachedCmsSignedData({
    rawSignature: sigBytes,
    certificateChainDer: chainDer,
    ...(signedAttrsDer !== undefined ? { signedAttrsDer } : {}),
  });
  if (!assembled) {
    throw new CaProviderError('unavailable', `${providerLabel} response did not contain valid signature or certificate DER`);
  }
  return {
    cmsDer: assembled,
    subFilter: cmsHasCadesSignedAttrs(assembled) ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.detached',
    certificateChainPem: chainDer.map(derCertToPem),
  };
}
