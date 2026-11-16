// SPDX-License-Identifier: AGPL-3.0-only
// Sandboxed PAdES-LTV CMS signature embedder for crove-extract (`pdf_embed_cms`, #3511).
// Runs inside the zero-egress parser process: validates the PDF against encryption, active content,
// and xref smuggling via seal.ts, validates DER CMS / optional timestamp / OCSP payloads, appends a
// clean incremental AcroForm + /Type /Sig update, and returns exact /ByteRange + signedSha256.
import { createHash } from 'node:crypto';
import {
  EXTRACT_LIMITS,
  decodePdfEmbedCmsInput,
  type PdfEmbedCmsResult,
} from '@crove/extract-contract';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib';
import {
  PdfSignError,
  decodeStrictBase64,
  loadValidatedPdfForIncrementalUpdate,
} from './seal.ts';

const DEFAULT_MIN_CMS_SLOT_BYTES = 4096;
const MAX_CONVERGENCE_PASSES = 6;

interface IncrementalObject {
  readonly objNum: number;
  readonly gen: number;
  readonly body: Buffer;
}

function assertValidDerSequence(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength < 2 || bytes[0] !== 0x30) {
    throw new PdfSignError(`${label} không đúng cấu trúc ASN.1 DER hợp lệ`);
  }
  const lenByte = bytes[1];
  if (lenByte === undefined) {
    throw new PdfSignError(`${label} không đúng cấu trúc ASN.1 DER hợp lệ`);
  }
  if (lenByte < 0x80) {
    if (bytes.byteLength !== 2 + lenByte) {
      throw new PdfSignError(`${label} có độ dài DER không khớp`);
    }
    return;
  }
  const octets = lenByte & 0x7f;
  if (octets === 0 || octets > 4 || bytes.byteLength < 2 + octets || bytes[2] === 0x00) {
    throw new PdfSignError(`${label} không đúng cấu trúc ASN.1 DER hợp lệ`);
  }
  let declared = 0;
  for (let i = 0; i < octets; i += 1) {
    const b = bytes[2 + i];
    if (b === undefined) {
      throw new PdfSignError(`${label} không đúng cấu trúc ASN.1 DER hợp lệ`);
    }
    declared = declared * 256 + b;
  }
  if (declared < 0x80 || bytes.byteLength !== 2 + octets + declared) {
    throw new PdfSignError(`${label} có độ dài DER không khớp`);
  }
}

function serializePdfObject(obj: PDFObject): Buffer {
  const size = obj.sizeInBytes();
  const buf = Buffer.alloc(size);
  const written = obj.copyBytesInto(buf, 0);
  return written === size ? buf : buf.subarray(0, written);
}

function encodePdfTextString(value: string): string {
  let asciiOnly = true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      asciiOnly = false;
      break;
    }
  }
  if (asciiOnly) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    return `(${escaped})`;
  }
  const out = Buffer.alloc(2 + value.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < value.length; i += 1) {
    out.writeUInt16BE(value.charCodeAt(i), 2 + i * 2);
  }
  return `<${out.toString('hex').toUpperCase()}>`;
}

function encodePdfDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new PdfSignError('Thời gian ký số không hợp lệ');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `(D:${y}${m}${d}${hh}${mm}${ss}Z)`;
}

function buildDerStreamBody(bytes: Uint8Array): Buffer {
  const head = Buffer.from(`<< /Length ${bytes.byteLength} >>\nstream\n`, 'ascii');
  const tail = Buffer.from('\nendstream', 'ascii');
  return Buffer.concat([head, bytes, tail]);
}

function collectExistingFieldNames(
  catalogDict: PDFDict,
  lookup: (ref: PDFRef) => PDFObject | undefined,
): Set<string> {
  const names = new Set<string>();
  const acroRaw = catalogDict.get(PDFName.of('AcroForm'));
  const acro = acroRaw instanceof PDFRef ? lookup(acroRaw) : acroRaw;
  if (!(acro instanceof PDFDict)) return names;
  const fieldsRaw = acro.get(PDFName.of('Fields'));
  const fields = fieldsRaw instanceof PDFRef ? lookup(fieldsRaw) : fieldsRaw;
  if (!(fields instanceof PDFArray)) return names;
  for (let i = 0; i < fields.size(); i += 1) {
    const item = fields.get(i);
    const dict = item instanceof PDFRef ? lookup(item) : item;
    if (!(dict instanceof PDFDict)) continue;
    const tRaw = dict.get(PDFName.of('T'));
    const tVal = tRaw instanceof PDFRef ? lookup(tRaw) : tRaw;
    if (tVal instanceof PDFString || tVal instanceof PDFHexString) {
      names.add(tVal.decodeText());
    }
  }
  return names;
}

function groupContiguousObjectRuns<T extends { readonly objNum: number }>(
  sortedItems: readonly T[],
): Array<readonly T[]> {
  const runs: Array<T[]> = [];
  for (const item of sortedItems) {
    const lastRun = runs[runs.length - 1];
    const prev = lastRun?.[lastRun.length - 1];
    if (lastRun && prev && item.objNum === prev.objNum + 1) {
      lastRun.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

interface SignatureSlotWrite {
  readonly objNum: number;
  readonly headerBuf: Buffer;
  readonly beforeContents: Buffer;
  readonly contentsBuf: Buffer;
  readonly afterContents: Buffer;
}

function buildIncrementalSuffix(options: {
  basePdfByteLength: number;
  needsLeadingNewline: boolean;
  objects: readonly IncrementalObject[];
  signature?: SignatureSlotWrite;
  rootRef: PDFRef;
  infoRef: PDFRef | null;
  prevStartXrefOffset: number;
  isXrefStream: boolean;
  prevMaxObjNum: number;
}): {
  readonly suffix: Buffer;
  readonly byteRange: readonly [0, number, number, number] | null;
  readonly startXrefOffset: number;
  readonly nextPrevMaxObjNum: number;
} {
  const sorted = [...options.objects].sort((a, b) => a.objNum - b.objNum);
  const chunks: Buffer[] = [];
  let cursor = 0;

  if (options.needsLeadingNewline) {
    const nl = Buffer.from('\n', 'ascii');
    chunks.push(nl);
    cursor += nl.byteLength;
  }

  const emitted: Array<{ readonly objNum: number; readonly gen: number; readonly offset: number }> = [];
  let ltAbsolute = -1;
  let gtAbsolute = -1;

  for (const obj of sorted) {
    const offset = options.basePdfByteLength + cursor;
    emitted.push({ objNum: obj.objNum, gen: obj.gen, offset });
    if (options.signature && obj.objNum === options.signature.objNum) {
      chunks.push(options.signature.headerBuf);
      cursor += options.signature.headerBuf.byteLength;
      chunks.push(options.signature.beforeContents);
      cursor += options.signature.beforeContents.byteLength;
      ltAbsolute = options.basePdfByteLength + cursor;
      chunks.push(options.signature.contentsBuf);
      cursor += options.signature.contentsBuf.byteLength;
      gtAbsolute = options.basePdfByteLength + cursor - 1;
      chunks.push(options.signature.afterContents);
      cursor += options.signature.afterContents.byteLength;
      const endBuf = Buffer.from('\nendobj\n', 'ascii');
      chunks.push(endBuf);
      cursor += endBuf.byteLength;
    } else {
      const head = Buffer.from(`${obj.objNum} ${obj.gen} obj\n`, 'ascii');
      const tail = Buffer.from('\nendobj\n', 'ascii');
      chunks.push(head, obj.body, tail);
      cursor += head.byteLength + obj.body.byteLength + tail.byteLength;
    }
  }

  const maxEmittedObjNum = emitted[emitted.length - 1]?.objNum ?? options.prevMaxObjNum;
  const xrefAbsoluteOffset = options.basePdfByteLength + cursor;
  const infoClause = options.infoRef
    ? ` /Info ${options.infoRef.objectNumber} ${options.infoRef.generationNumber} R`
    : '';
  let nextPrevMaxObjNum: number;

  if (!options.isXrefStream) {
    const newSize = Math.max(options.prevMaxObjNum + 1, maxEmittedObjNum + 1);
    nextPrevMaxObjNum = newSize - 1;
    const runs = groupContiguousObjectRuns(emitted);
    const lines: string[] = ['xref'];
    for (const run of runs) {
      const first = run[0];
      if (!first) continue;
      lines.push(`${first.objNum} ${run.length}`);
      for (const entry of run) {
        lines.push(`${String(entry.offset).padStart(10, '0')} ${String(entry.gen).padStart(5, '0')} n `);
      }
    }
    lines.push(
      'trailer',
      `<< /Size ${newSize} /Root ${options.rootRef.objectNumber} ${options.rootRef.generationNumber} R${infoClause} /Prev ${options.prevStartXrefOffset} >>`,
      'startxref',
      String(xrefAbsoluteOffset),
      '%%EOF',
      '',
    );
    chunks.push(Buffer.from(lines.join('\n'), 'ascii'));
  } else {
    const xrefObjNum = Math.max(options.prevMaxObjNum, maxEmittedObjNum) + 1;
    const newSize = xrefObjNum + 1;
    nextPrevMaxObjNum = xrefObjNum;
    const allEntries = [...emitted, { objNum: xrefObjNum, gen: 0, offset: xrefAbsoluteOffset }];
    const runs = groupContiguousObjectRuns(allEntries);
    const indexPairs: number[] = [];
    for (const run of runs) {
      const first = run[0];
      if (!first) continue;
      indexPairs.push(first.objNum, run.length);
    }
    const payload = Buffer.alloc(allEntries.length * 7);
    for (let i = 0; i < allEntries.length; i += 1) {
      const entry = allEntries[i];
      if (!entry) continue;
      payload.writeUInt8(1, i * 7);
      payload.writeUInt32BE(entry.offset, i * 7 + 1);
      payload.writeUInt16BE(entry.gen, i * 7 + 5);
    }
    const xrefHead = Buffer.from(
      `${xrefObjNum} 0 obj\n<< /Type /XRef /Size ${newSize} /Index [${indexPairs.join(' ')}] /W [1 4 2] /Root ${options.rootRef.objectNumber} ${options.rootRef.generationNumber} R${infoClause} /Prev ${options.prevStartXrefOffset} /Length ${payload.byteLength} >>\nstream\n`,
      'ascii',
    );
    const xrefTail = Buffer.from(
      `\nendstream\nendobj\nstartxref\n${xrefAbsoluteOffset}\n%%EOF\n`,
      'ascii',
    );
    chunks.push(xrefHead, payload, xrefTail);
  }

  const suffix = Buffer.concat(chunks);
  if (!options.signature) {
    return {
      suffix,
      byteRange: null,
      startXrefOffset: xrefAbsoluteOffset,
      nextPrevMaxObjNum,
    };
  }
  const totalBytes = options.basePdfByteLength + suffix.byteLength;
  const offset1 = ltAbsolute;
  const offset2 = gtAbsolute + 1;
  const len2 = totalBytes - offset2;
  return {
    suffix,
    byteRange: [0, offset1, offset2, len2],
    startXrefOffset: xrefAbsoluteOffset,
    nextPrevMaxObjNum,
  };
}

export async function embedPdfCms(bytes: Uint8Array): Promise<PdfEmbedCmsResult> {
  const input = decodePdfEmbedCmsInput(bytes);
  const pdfBytes = decodeStrictBase64(input.pdfBase64, 'Tài liệu PDF');
  const validated = await loadValidatedPdfForIncrementalUpdate(pdfBytes);
  const { pdfDoc, prevStartXrefOffset, isXrefStream, maxObjNum } = validated;

  const cmsDer = decodeStrictBase64(input.cmsDerBase64, 'Chữ ký số CMS');
  if (cmsDer.byteLength < 2 || cmsDer.byteLength > EXTRACT_LIMITS.maxPdfCmsDerBytes) {
    throw new PdfSignError('Kích thước chữ ký số CMS vượt quá giới hạn cho phép');
  }
  assertValidDerSequence(cmsDer, 'Chữ ký số CMS');

  const timestampTokenDer = input.timestampTokenBase64
    ? decodeStrictBase64(input.timestampTokenBase64, 'Dấu thời gian RFC 3161')
    : null;
  if (timestampTokenDer) {
    if (timestampTokenDer.byteLength > EXTRACT_LIMITS.maxPdfCmsTimestampBytes) {
      throw new PdfSignError('Kích thước dấu thời gian vượt quá giới hạn cho phép');
    }
    assertValidDerSequence(timestampTokenDer, 'Dấu thời gian RFC 3161');
  }

  const ocspResponsesDer: Uint8Array[] = [];
  if (input.ocspResponsesBase64) {
    for (const ocspB64 of input.ocspResponsesBase64) {
      const ocspDer = decodeStrictBase64(ocspB64, 'Phản hồi OCSP');
      if (ocspDer.byteLength > EXTRACT_LIMITS.maxPdfCmsOcspBytes) {
        throw new PdfSignError('Kích thước phản hồi OCSP vượt quá giới hạn cho phép');
      }
      assertValidDerSequence(ocspDer, 'Phản hồi OCSP');
      ocspResponsesDer.push(ocspDer);
    }
  }

  if (input.placeholderBytes !== undefined && cmsDer.byteLength > input.placeholderBytes) {
    throw new PdfSignError('Dữ liệu CMS vượt quá kích thước vùng chữ ký dự phòng');
  }
  const slotBytes =
    input.placeholderBytes ??
    Math.max(DEFAULT_MIN_CMS_SLOT_BYTES, Math.ceil(cmsDer.byteLength / 512) * 512);
  const cmsHex = Buffer.from(cmsDer).toString('hex');
  const paddedCmsHex = cmsHex.padEnd(slotBytes * 2, '0');

  const rootRef = pdfDoc.context.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) {
    throw new PdfSignError('Không xác định được gốc /Root của tài liệu PDF');
  }
  const catalogDict = pdfDoc.context.lookupMaybe(rootRef, PDFDict);
  if (!catalogDict) {
    throw new PdfSignError('Đối tượng gốc /Root của tệp PDF không hợp lệ');
  }
  const infoRef = pdfDoc.context.trailerInfo.Info instanceof PDFRef ? pdfDoc.context.trailerInfo.Info : null;

  const existingNames = collectExistingFieldNames(catalogDict, (ref) => pdfDoc.context.lookup(ref));
  let fieldName = input.fieldName;
  if (fieldName !== undefined) {
    if (existingNames.has(fieldName)) {
      throw new PdfSignError(`Tên trường chữ ký /T "${fieldName}" đã tồn tại trong tài liệu PDF`);
    }
  } else {
    let idx = 1;
    while (existingNames.has(`Signature${idx}`)) idx += 1;
    fieldName = `Signature${idx}`;
  }

  const firstPage = pdfDoc.getPage(0);
  const firstPageRef = firstPage.ref;
  const firstPageDict = firstPage.node;

  let nextObjNum = maxObjNum + 1;
  const sigObjNum = nextObjNum++;
  const widgetObjNum = nextObjNum++;
  const sigRef = PDFRef.of(sigObjNum, 0);
  const widgetRef = PDFRef.of(widgetObjNum, 0);

  const widgetDict = PDFDict.withContext(pdfDoc.context);
  widgetDict.set(PDFName.of('Type'), PDFName.of('Annot'));
  widgetDict.set(PDFName.of('Subtype'), PDFName.of('Widget'));
  widgetDict.set(PDFName.of('FT'), PDFName.of('Sig'));
  widgetDict.set(PDFName.of('T'), PDFString.of(fieldName));
  widgetDict.set(PDFName.of('V'), sigRef);
  widgetDict.set(PDFName.of('P'), firstPageRef);
  const rect = PDFArray.withContext(pdfDoc.context);
  rect.push(PDFNumber.of(0));
  rect.push(PDFNumber.of(0));
  rect.push(PDFNumber.of(0));
  rect.push(PDFNumber.of(0));
  widgetDict.set(PDFName.of('Rect'), rect);
  widgetDict.set(PDFName.of('F'), PDFNumber.of(132));

  const incrementalObjects: IncrementalObject[] = [
    { objNum: widgetObjNum, gen: 0, body: serializePdfObject(widgetDict) },
  ];

  // Attach the signature widget to page 1's /Annots (updating indirect /Annots if indirect, else page dict).
  const pageAnnotsRaw = firstPageDict.get(PDFName.of('Annots'));
  if (pageAnnotsRaw instanceof PDFRef) {
    const existingAnnots = pdfDoc.context.lookupMaybe(pageAnnotsRaw, PDFArray);
    if (!existingAnnots) {
      throw new PdfSignError('Danh sách chú thích /Annots trên trang PDF không hợp lệ');
    }
    const nextAnnots = existingAnnots.clone(pdfDoc.context);
    nextAnnots.push(widgetRef);
    incrementalObjects.push({
      objNum: pageAnnotsRaw.objectNumber,
      gen: pageAnnotsRaw.generationNumber,
      body: serializePdfObject(nextAnnots),
    });
  } else {
    const nextPageDict = firstPageDict.clone(pdfDoc.context);
    const nextAnnots =
      pageAnnotsRaw instanceof PDFArray ? pageAnnotsRaw.clone(pdfDoc.context) : PDFArray.withContext(pdfDoc.context);
    nextAnnots.push(widgetRef);
    nextPageDict.set(PDFName.of('Annots'), nextAnnots);
    incrementalObjects.push({
      objNum: firstPageRef.objectNumber,
      gen: firstPageRef.generationNumber,
      body: serializePdfObject(nextPageDict),
    });
  }

  const appendWidgetToAcroDict = (nextAcro: PDFDict): void => {
    const existingFieldsRaw = nextAcro.get(PDFName.of('Fields'));
    if (existingFieldsRaw instanceof PDFRef) {
      const existingFields = pdfDoc.context.lookupMaybe(existingFieldsRaw, PDFArray);
      if (!existingFields) {
        throw new PdfSignError('Trường /Fields của /AcroForm không hợp lệ');
      }
      const nextFields = existingFields.clone(pdfDoc.context);
      nextFields.push(widgetRef);
      incrementalObjects.push({
        objNum: existingFieldsRaw.objectNumber,
        gen: existingFieldsRaw.generationNumber,
        body: serializePdfObject(nextFields),
      });
    } else if (existingFieldsRaw === undefined || existingFieldsRaw instanceof PDFArray) {
      const nextFields =
        existingFieldsRaw instanceof PDFArray
          ? existingFieldsRaw.clone(pdfDoc.context)
          : PDFArray.withContext(pdfDoc.context);
      nextFields.push(widgetRef);
      nextAcro.set(PDFName.of('Fields'), nextFields);
    } else {
      throw new PdfSignError('Trường /Fields của /AcroForm không hợp lệ');
    }
    nextAcro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  };

  // Update or create /AcroForm with /SigFlags 3 (SignaturesExist | AppendOnly).
  let needCatalogUpdate = false;
  const nextCatalogDict = catalogDict.clone(pdfDoc.context);
  const existingAcroRaw = catalogDict.get(PDFName.of('AcroForm'));
  if (existingAcroRaw === undefined) {
    const acroObjNum = nextObjNum++;
    const acroDict = PDFDict.withContext(pdfDoc.context);
    const fieldsArr = PDFArray.withContext(pdfDoc.context);
    fieldsArr.push(widgetRef);
    acroDict.set(PDFName.of('Fields'), fieldsArr);
    acroDict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
    incrementalObjects.push({ objNum: acroObjNum, gen: 0, body: serializePdfObject(acroDict) });
    nextCatalogDict.set(PDFName.of('AcroForm'), PDFRef.of(acroObjNum, 0));
    needCatalogUpdate = true;
  } else if (existingAcroRaw instanceof PDFRef) {
    const existingAcro = pdfDoc.context.lookupMaybe(existingAcroRaw, PDFDict);
    if (!existingAcro) {
      throw new PdfSignError('Đối tượng /AcroForm của tài liệu PDF không hợp lệ');
    }
    const nextAcro = existingAcro.clone(pdfDoc.context);
    appendWidgetToAcroDict(nextAcro);
    incrementalObjects.push({
      objNum: existingAcroRaw.objectNumber,
      gen: existingAcroRaw.generationNumber,
      body: serializePdfObject(nextAcro),
    });
  } else if (existingAcroRaw instanceof PDFDict) {
    const nextAcro = existingAcroRaw.clone(pdfDoc.context);
    appendWidgetToAcroDict(nextAcro);
    nextCatalogDict.set(PDFName.of('AcroForm'), nextAcro);
    needCatalogUpdate = true;
  } else {
    throw new PdfSignError('Đối tượng /AcroForm của tài liệu PDF không hợp lệ');
  }

  if (needCatalogUpdate) {
    incrementalObjects.push({
      objNum: rootRef.objectNumber,
      gen: rootRef.generationNumber,
      body: serializePdfObject(nextCatalogDict),
    });
  }

  // Reserve a placeholder slot for sigObjNum; buildIncrementalSuffix writes its bytes directly.
  incrementalObjects.push({ objNum: sigObjNum, gen: 0, body: Buffer.alloc(0) });

  const subFilter = input.subFilter ?? 'ETSI.CAdES.detached';
  const metaParts = [
    `/Name ${encodePdfTextString(input.signerName)}`,
    `/M ${encodePdfDate(input.signedAtIso)}`,
  ];
  if (input.reason !== undefined) metaParts.push(`/Reason ${encodePdfTextString(input.reason)}`);
  if (input.location !== undefined) metaParts.push(`/Location ${encodePdfTextString(input.location)}`);
  const metaSuffix = ` ${metaParts.join(' ')}`;

  const sigHeaderBuf = Buffer.from(`${sigObjNum} 0 obj\n`, 'ascii');
  const sigContentsBuf = Buffer.from(`<${paddedCmsHex}>`, 'ascii');
  const sigAfterContents = Buffer.from(`${metaSuffix} >>`, 'ascii');
  const needsLeadingNewline =
    pdfBytes.byteLength > 0 &&
    pdfBytes[pdfBytes.byteLength - 1] !== 0x0a &&
    pdfBytes[pdfBytes.byteLength - 1] !== 0x0d;

  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let finalSuffix: Buffer | null = null;
  let finalByteRange: readonly [0, number, number, number] | null = null;
  let update1StartXrefOffset = prevStartXrefOffset;
  let update1NextPrevMaxObjNum = maxObjNum;

  for (let pass = 0; pass < MAX_CONVERGENCE_PASSES; pass += 1) {
    const sigBeforeContents = Buffer.from(
      `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} /ByteRange [0 ${b1} ${b2} ${b3}] /Contents `,
      'ascii',
    );
    const built = buildIncrementalSuffix({
      basePdfByteLength: pdfBytes.byteLength,
      needsLeadingNewline,
      objects: incrementalObjects,
      signature: {
        objNum: sigObjNum,
        headerBuf: sigHeaderBuf,
        beforeContents: sigBeforeContents,
        contentsBuf: sigContentsBuf,
        afterContents: sigAfterContents,
      },
      rootRef,
      infoRef,
      prevStartXrefOffset,
      isXrefStream,
      prevMaxObjNum: maxObjNum,
    });
    if (!built.byteRange) {
      throw new PdfSignError('Không tính được vị trí ByteRange cho chữ ký số PDF');
    }
    const [, nextB1, nextB2, nextB3] = built.byteRange;
    if (nextB1 === b1 && nextB2 === b2 && nextB3 === b3) {
      finalSuffix = built.suffix;
      finalByteRange = built.byteRange;
      update1StartXrefOffset = built.startXrefOffset;
      update1NextPrevMaxObjNum = built.nextPrevMaxObjNum;
      break;
    }
    b1 = nextB1;
    b2 = nextB2;
    b3 = nextB3;
  }

  if (!finalSuffix || !finalByteRange) {
    throw new PdfSignError('Không tính được vị trí ByteRange ổn định cho chữ ký số PDF');
  }

  const signedBytes = new Uint8Array(pdfBytes.byteLength + finalSuffix.byteLength);
  signedBytes.set(pdfBytes, 0);
  signedBytes.set(finalSuffix, pdfBytes.byteLength);

  if (
    signedBytes[finalByteRange[1]] !== 0x3c ||
    signedBytes[finalByteRange[2] - 1] !== 0x3e ||
    finalByteRange[2] + finalByteRange[3] !== signedBytes.byteLength
  ) {
    throw new PdfSignError('Vị trí ByteRange trong PDF không khớp nội dung /Contents');
  }

  // Append PAdES-LTV /DSS in a separate post-signature incremental update so ByteRange digest remains invariant.
  let outBytes: Uint8Array = signedBytes;
  if (ocspResponsesDer.length > 0 || timestampTokenDer !== null) {
    let dssObjCursor = update1NextPrevMaxObjNum + 1;
    const dssObjects: IncrementalObject[] = [];

    const ocspRefs: PDFRef[] = [];
    for (const ocspDer of ocspResponsesDer) {
      const ocspObjNum = dssObjCursor++;
      dssObjects.push({ objNum: ocspObjNum, gen: 0, body: buildDerStreamBody(ocspDer) });
      ocspRefs.push(PDFRef.of(ocspObjNum, 0));
    }

    let tsRef: PDFRef | null = null;
    if (timestampTokenDer) {
      const tsObjNum = dssObjCursor++;
      dssObjects.push({ objNum: tsObjNum, gen: 0, body: buildDerStreamBody(timestampTokenDer) });
      tsRef = PDFRef.of(tsObjNum, 0);
    }

    // ETSI EN 319 142-1 VRI dictionary key is uppercase hex SHA-1 of the CMS /Contents DER bytes.
    const vriKey = createHash('sha1').update(cmsDer).digest('hex').toUpperCase();
    const vriEntry = PDFDict.withContext(pdfDoc.context);
    vriEntry.set(PDFName.of('TU'), PDFString.of(encodePdfDate(input.signedAtIso).slice(1, -1)));
    if (ocspRefs.length > 0) {
      const vriOcsp = PDFArray.withContext(pdfDoc.context);
      for (const ref of ocspRefs) vriOcsp.push(ref);
      vriEntry.set(PDFName.of('OCSP'), vriOcsp);
    }
    if (tsRef) {
      vriEntry.set(PDFName.of('TS'), tsRef);
    }

    const existingDssRaw = catalogDict.get(PDFName.of('DSS'));
    let nextDss: PDFDict;
    let dssRefForUpdate: PDFRef | null = null;
    if (existingDssRaw === undefined) {
      nextDss = PDFDict.withContext(pdfDoc.context);
    } else if (existingDssRaw instanceof PDFRef) {
      const existingDss = pdfDoc.context.lookupMaybe(existingDssRaw, PDFDict);
      if (!existingDss) {
        throw new PdfSignError('Đối tượng /DSS của tài liệu PDF không hợp lệ');
      }
      nextDss = existingDss.clone(pdfDoc.context);
      dssRefForUpdate = existingDssRaw;
    } else if (existingDssRaw instanceof PDFDict) {
      nextDss = existingDssRaw.clone(pdfDoc.context);
    } else {
      throw new PdfSignError('Đối tượng /DSS của tài liệu PDF không hợp lệ');
    }

    nextDss.set(PDFName.of('Type'), PDFName.of('DSS'));

    if (ocspRefs.length > 0) {
      const existingOcspsRaw = nextDss.get(PDFName.of('OCSPs'));
      if (existingOcspsRaw instanceof PDFRef) {
        const existingOcsps = pdfDoc.context.lookupMaybe(existingOcspsRaw, PDFArray);
        if (!existingOcsps) {
          throw new PdfSignError('Danh sách /OCSPs trong /DSS không hợp lệ');
        }
        const nextOcsps = existingOcsps.clone(pdfDoc.context);
        for (const ref of ocspRefs) nextOcsps.push(ref);
        dssObjects.push({
          objNum: existingOcspsRaw.objectNumber,
          gen: existingOcspsRaw.generationNumber,
          body: serializePdfObject(nextOcsps),
        });
      } else if (existingOcspsRaw === undefined || existingOcspsRaw instanceof PDFArray) {
        const nextOcsps =
          existingOcspsRaw instanceof PDFArray
            ? existingOcspsRaw.clone(pdfDoc.context)
            : PDFArray.withContext(pdfDoc.context);
        for (const ref of ocspRefs) nextOcsps.push(ref);
        nextDss.set(PDFName.of('OCSPs'), nextOcsps);
      } else {
        throw new PdfSignError('Danh sách /OCSPs trong /DSS không hợp lệ');
      }
    }

    const existingVriRaw = nextDss.get(PDFName.of('VRI'));
    if (existingVriRaw instanceof PDFRef) {
      const existingVri = pdfDoc.context.lookupMaybe(existingVriRaw, PDFDict);
      if (!existingVri) {
        throw new PdfSignError('Từ điển /VRI trong /DSS không hợp lệ');
      }
      const nextVri = existingVri.clone(pdfDoc.context);
      nextVri.set(PDFName.of(vriKey), vriEntry);
      dssObjects.push({
        objNum: existingVriRaw.objectNumber,
        gen: existingVriRaw.generationNumber,
        body: serializePdfObject(nextVri),
      });
    } else if (existingVriRaw === undefined || existingVriRaw instanceof PDFDict) {
      const nextVri =
        existingVriRaw instanceof PDFDict
          ? existingVriRaw.clone(pdfDoc.context)
          : PDFDict.withContext(pdfDoc.context);
      nextVri.set(PDFName.of(vriKey), vriEntry);
      nextDss.set(PDFName.of('VRI'), nextVri);
    } else {
      throw new PdfSignError('Từ điển /VRI trong /DSS không hợp lệ');
    }

    if (dssRefForUpdate !== null) {
      dssObjects.push({
        objNum: dssRefForUpdate.objectNumber,
        gen: dssRefForUpdate.generationNumber,
        body: serializePdfObject(nextDss),
      });
    } else {
      const dssObjNum = dssObjCursor++;
      dssObjects.push({ objNum: dssObjNum, gen: 0, body: serializePdfObject(nextDss) });
      nextCatalogDict.set(PDFName.of('DSS'), PDFRef.of(dssObjNum, 0));
      dssObjects.push({
        objNum: rootRef.objectNumber,
        gen: rootRef.generationNumber,
        body: serializePdfObject(nextCatalogDict),
      });
    }

    const signedNeedsNewline =
      signedBytes.byteLength > 0 &&
      signedBytes[signedBytes.byteLength - 1] !== 0x0a &&
      signedBytes[signedBytes.byteLength - 1] !== 0x0d;
    const update2 = buildIncrementalSuffix({
      basePdfByteLength: signedBytes.byteLength,
      needsLeadingNewline: signedNeedsNewline,
      objects: dssObjects,
      rootRef,
      infoRef,
      prevStartXrefOffset: update1StartXrefOffset,
      isXrefStream,
      prevMaxObjNum: update1NextPrevMaxObjNum,
    });
    const combined = new Uint8Array(signedBytes.byteLength + update2.suffix.byteLength);
    combined.set(signedBytes, 0);
    combined.set(update2.suffix, signedBytes.byteLength);
    outBytes = combined;
  }

  if (outBytes.byteLength > EXTRACT_LIMITS.maxFileBytes) {
    throw new PdfSignError('Tệp PDF sau khi nhúng chữ ký số vượt quá giới hạn 25 MiB cho phép');
  }

  const pdfBase64 = Buffer.from(outBytes).toString('base64');
  if (pdfBase64.length + 256 > EXTRACT_LIMITS.maxResponseBytes) {
    throw new PdfSignError('Tệp PDF sau khi nhúng chữ ký số vượt quá kích thước phản hồi cho phép');
  }

  const signedSha256 = createHash('sha256').update(outBytes).digest('hex');

  return {
    ok: true,
    kind: 'pdf_embed_cms',
    pdfBase64,
    signedSha256,
    byteRange: [0, finalByteRange[1], finalByteRange[2], finalByteRange[3]],
  };
}
