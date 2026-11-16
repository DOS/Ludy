// SPDX-License-Identifier: AGPL-3.0-only
// Pure ASN.1 DER CMS ContentInfo(SignedData) inspector and detached RFC 5652 assembler.
// Converts raw remote-CA digest signatures + X.509 certificates into detached SignedData DER
// with zero external PDF or cryptographic dependencies beyond Node built-in node:crypto.
import { X509Certificate } from 'node:crypto';
import { decodeBase64Bytes, isValidDerSequence, readText } from './http.ts';
import { CaProviderError } from './port.ts';

// OIDs: signedData (1.2.840.113549.1.7.2), data (1.2.840.113549.1.7.1),
// sha256 (2.16.840.1.101.3.4.2.1), sha256WithRSAEncryption (1.2.840.113549.1.1.11),
// id-ecPublicKey (1.2.840.10045.2.1), ecdsa-with-SHA256 (1.2.840.10045.4.3.2).
const OID_SIGNED_DATA = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
const OID_DATA = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
const OID_SHA256 = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const OID_RSA_SHA256 = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
const OID_EC_PUBLIC_KEY = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_ECDSA_SHA256 = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);

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

export function assembleDetachedCmsSignedData(options: {
  readonly rawSignature: Uint8Array;
  readonly certificateChainDer: readonly Uint8Array[];
}): Uint8Array | null {
  const { rawSignature, certificateChainDer } = options;
  if (rawSignature.byteLength < 32 || rawSignature.byteLength > 4096 || certificateChainDer.length === 0) {
    return null;
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

  const signerInfo = derSeq(
    derInt(1),
    derSeq(meta.issuerTlv, meta.serialTlv),
    sha256Alg,
    sigAlg,
    derNode(0x04, rawSignature),
  );
  const certsField = derNode(0xa0, concatBytes(...certificateChainDer));
  const signedData = derSeq(
    derInt(1),
    derSet(sha256Alg),
    derSeq(derOid(OID_DATA)),
    certsField,
    derSet(signerInfo),
  );
  return derSeq(derOid(OID_SIGNED_DATA), derTagged0(signedData));
}

export async function resolveCmsOrWrapRawSignature(options: {
  readonly providerLabel: string;
  readonly sigBytes: Uint8Array;
  readonly rawChain: unknown;
  readonly inlineChainDer: readonly Uint8Array[];
  readonly loadChainDer: () => Promise<readonly Uint8Array[] | null>;
}): Promise<{ readonly cmsDer: Uint8Array; readonly certificateChainPem: string[] }> {
  const { providerLabel, sigBytes, rawChain, inlineChainDer, loadChainDer } = options;
  if (isCmsSignedDataDer(sigBytes)) {
    const certificateChainPem = Array.isArray(rawChain)
      ? rawChain.map(readText).filter((v): v is string => v !== null)
      : inlineChainDer.map(derCertToPem);
    return { cmsDer: sigBytes, certificateChainPem };
  }
  const chainDer = inlineChainDer.length > 0 ? inlineChainDer : await loadChainDer();
  if (!chainDer || chainDer.length === 0) {
    throw new CaProviderError('unavailable', `${providerLabel} certificate chain required to wrap raw signature in CMS`);
  }
  const assembled = assembleDetachedCmsSignedData({ rawSignature: sigBytes, certificateChainDer: chainDer });
  if (!assembled) {
    throw new CaProviderError('unavailable', `${providerLabel} response did not contain valid signature or certificate DER`);
  }
  return { cmsDer: assembled, certificateChainPem: chainDer.map(derCertToPem) };
}
