// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import { DocxError } from '../src/docx-text.ts';
import { MAX_DOCX_PARAGRAPH_CHARS, convertDocxToPdf } from '../src/docx-to-pdf.ts';
import { PdfFontContext } from '../src/fonts.ts';
import { parse } from '../src/parse.ts';
import { createExtractApp } from '../src/server.ts';
import { buildZip } from './zip-fixture.ts';

function buildDocx(parts: Record<string, string>) {
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    ...Object.entries(parts).map(([name, data]) => ({ name, data })),
  ]);
}

describe('docx_to_pdf conversion (#4721)', () => {
  it('converts Vietnamese headings, lists, tables, page breaks and split placeholder tags into a tagged A4 PDF', async () => {
    const docx = buildDocx({
      'word/styles.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>',
        '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>',
        '</w:styles>',
      ].join(''),
      'word/numbering.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>',
        '<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>',
        '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>',
        '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>',
        '</w:numbering>',
      ].join(''),
      'word/document.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>HỢP ĐỒNG CUNG CẤP DỊCH VỤ</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Điều khoản thanh toán bằng đồng Việt Nam.</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Cam kết bảo mật thông tin giữa hai bên.</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Hỗ trợ kỹ thuật trực tuyến.</w:t></w:r></w:p>',
        '<w:tbl>',
        '  <w:tblPr><w:tblBorders><w:top w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr>',
        '  <w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>',
        '  <w:tr>',
        '    <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bên A</w:t></w:r></w:p></w:tc>',
        '    <w:tc><w:p><w:r><w:t>Công ty TNHH Thương Mại Ánh Dương</w:t></w:r></w:p></w:tc>',
        '  </w:tr>',
        '</w:tbl>',
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Đại diện ký tên: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{{sig</w:t></w:r><w:r><w:t>nature, r1}}</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Ngày ký: {{date, r1}} | Ghi chú: {{text, r1}} | Chọn: {{dropdown, r1, Đồng ý|Từ chối}}</w:t></w:r></w:p>',
        '</w:body></w:document>',
      ].join(''),
    });

    const converted = await parse('docx_to_pdf', docx);
    expect(converted.ok).toBe(true);
    if (!converted.ok || converted.kind !== 'docx_to_pdf') {
      throw new Error(`unexpected result: ${JSON.stringify(converted)}`);
    }
    expect(converted.pageCount).toBe(2);
    expect(converted.warnings).toEqual([]);

    const pdfBytes = Buffer.from(converted.pdfBase64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    expect(pdfDoc.getPageCount()).toBe(2);
    const pageSize = pdfDoc.getPage(0).getSize();
    expect(pageSize.width).toBeCloseTo(595.28, 1);
    expect(pageSize.height).toBeCloseTo(841.89, 1);

    const inspected = await parse('pdf_inspect', pdfBytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || inspected.kind !== 'pdf_inspect') {
      throw new Error(`unexpected inspect result: ${JSON.stringify(inspected)}`);
    }
    expect(inspected.pageCount).toBe(2);
    const fullText = inspected.pages.map((p) => p.text).join('\n');
    expect(fullText).toContain('HỢP ĐỒNG CUNG CẤP DỊCH VỤ');
    expect(fullText).toContain('1. Điều khoản thanh toán bằng đồng Việt Nam.');
    expect(fullText).toContain('2. Cam kết bảo mật thông tin giữa hai bên.');
    expect(fullText).toContain('Công ty TNHH Thương Mại Ánh Dương');

    expect(inspected.detectedTags.map((t) => [t.fieldType, t.roleKey, t.pageNumber])).toEqual([
      ['signature', 'r1', 2],
      ['date', 'r1', 2],
      ['text', 'r1', 2],
      ['dropdown', 'r1', 2],
    ]);
    const dropdownTag = inspected.detectedTags.find((t) => t.fieldType === 'dropdown');
    expect(dropdownTag?.options).toEqual(['Đồng ý', 'Từ chối']);
  });

  it('emits typed warnings for skipped images, floating shapes, OLE objects, multi-columns and headers/footers', async () => {
    const docx = buildDocx({
      'word/header1.xml':
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Mẫu nội bộ</w:t></w:r></w:p></w:hdr>',
      'word/media/logo.png': 'fake-png',
      'word/embeddings/sheet.xlsx': 'fake-ole',
      'word/document.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:drawing><wp:anchor><a:blip/></wp:anchor></w:drawing><w:object/><w:t>Nội dung hợp đồng</w:t></w:r></w:p>',
        '<w:sectPr><w:cols w:num="2"/></w:sectPr>',
        '</w:body></w:document>',
      ].join(''),
    });

    const converted = await parse('docx_to_pdf', docx);
    expect(converted.ok).toBe(true);
    if (!converted.ok || converted.kind !== 'docx_to_pdf') throw new Error('expected ok');
    expect(new Set(converted.warnings)).toEqual(
      new Set([
        'images_skipped',
        'ole_objects_skipped',
        'headers_footers_simplified',
        'floating_shapes_skipped',
        'complex_columns_simplified',
      ]),
    );
  });

  it('refuses XXE, OLE2, encrypted entries, Track Changes, hidden text, empty and >200-page inputs fail-closed', async () => {
    const emptyRes = await parse('docx_to_pdf', new Uint8Array(0));
    expect(emptyRes).toMatchObject({ ok: false, code: 'invalid' });

    const tooBigRes = await parse('docx_to_pdf', new Uint8Array(EXTRACT_LIMITS.maxSignDocxBytes + 1));
    expect(tooBigRes).toMatchObject({ ok: false, code: 'invalid' });

    const app = createExtractApp();
    const httpTooBig = await app.request('/extract?kind=docx_to_pdf', {
      method: 'POST',
      body: new Uint8Array(EXTRACT_LIMITS.maxSignDocxBytes + 1),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(httpTooBig.status).toBe(413);
    expect(await httpTooBig.json()).toMatchObject({ ok: false, code: 'too_large' });

    const ole2Res = await parse('docx_to_pdf', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    expect(ole2Res).toMatchObject({ ok: false, code: 'invalid' });

    const encryptedPkg = buildDocx({
      EncryptionInfo: 'secret-header',
      EncryptedPackage: 'ciphertext',
      'word/document.xml': '<w:document><w:body><w:p/></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', encryptedPkg)).toMatchObject({ ok: false, code: 'invalid' });

    const xxe = buildDocx({
      'word/document.xml':
        '<?xml version="1.0"?><!DOCTYPE doc [<!ENTITY secret "leak">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', xxe)).toMatchObject({ ok: false, code: 'invalid' });

    for (const tcTag of [
      '<w:ins w:id="1"><w:r><w:t>Điều khoản chèn</w:t></w:r></w:ins>',
      '<w:del w:id="2"><w:r><w:delText>Điều khoản xóa</w:delText></w:r></w:del>',
      '<w:moveFrom w:id="3"><w:r><w:t>Chuyển đi</w:t></w:r></w:moveFrom>',
      '<w:moveTo w:id="4"><w:r><w:t>Chuyển đến</w:t></w:r></w:moveTo>',
    ]) {
      const tracked = buildDocx({
        'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${tcTag}</w:p></w:body></w:document>`,
      });
      expect(await parse('docx_to_pdf', tracked)).toMatchObject({ ok: false, code: 'invalid' });
    }

    const hiddenRun = buildDocx({
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Điều khoản bí mật</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', hiddenRun)).toMatchObject({ ok: false, code: 'invalid' });

    const falseVanishAllowed = buildDocx({
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>Hợp đồng bình thường</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', falseVanishAllowed)).toMatchObject({ ok: true, kind: 'docx_to_pdf', pageCount: 1 });

    const manyBreaks = Array.from({ length: 201 }, (_, i) => `<w:p><w:r><w:t>Trang ${i + 1}</w:t><w:br w:type="page"/></w:r></w:p>`).join('');
    const tooManyPages = buildDocx({
      'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${manyBreaks}</w:body></w:document>`,
    });
    expect(await parse('docx_to_pdf', tooManyPages)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('resolves XML namespaces by URI, rejects aliased revisions/vanish, formatting revisions, unclosed XML, and docDefaults vanish', async () => {
    const aliasedValid = buildDocx({
      'word/document.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<x:body><x:p><x:r><x:rPr><x:b/><x:vanish x:val="0"/></x:rPr><x:t>Hợp đồng chuẩn hóa</x:t></x:r></x:p></x:body>',
        '</x:document>',
      ].join(''),
    });
    const aliasedRes = await parse('docx_to_pdf', aliasedValid);
    expect(aliasedRes).toMatchObject({ ok: true, kind: 'docx_to_pdf', pageCount: 1 });
    if (!aliasedRes.ok || aliasedRes.kind !== 'docx_to_pdf') throw new Error('expected ok');
    const inspected = await parse('pdf_inspect', Buffer.from(aliasedRes.pdfBase64, 'base64'));
    expect(inspected).toMatchObject({ ok: true, kind: 'pdf_inspect' });
    if (inspected.ok && inspected.kind === 'pdf_inspect') {
      expect(inspected.pages[0]?.text).toContain('Hợp đồng chuẩn hóa');
    }

    const strictDefaultNsValid = buildDocx({
      'word/document.xml':
        '<?xml version="1.0" encoding="UTF-8"?><document xmlns="http://purl.oclc.org/ooxml/wordprocessingml/main"><body><p><r><t>Strict OOXML</t></r></p></body></document>',
    });
    expect(await parse('docx_to_pdf', strictDefaultNsValid)).toMatchObject({ ok: true, kind: 'docx_to_pdf', pageCount: 1 });

    for (const badAliasDoc of [
      '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:ins x:id="1"><x:r><x:t>Chèn</x:t></x:r></x:ins></x:p></x:body></x:document>',
      '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:del x:id="1"><x:r><x:delText>Xóa</x:delText></x:r></x:del></x:p></x:body></x:document>',
      '<x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body><x:p><x:r><x:rPr><x:vanish/></x:rPr><x:t>Ẩn</x:t></x:r></x:p></x:body></x:document>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pPrChange w:id="1"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Đổi định dạng</w:t></w:r></w:p></w:body></w:document>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Chưa đóng</w:t></w:r></w:p></w:body>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p></w:r></w:body></w:document>',
    ]) {
      expect(await parse('docx_to_pdf', buildDocx({ 'word/document.xml': badAliasDoc }))).toMatchObject({ ok: false, code: 'invalid' });
    }

    const docDefaultsHidden = buildDocx({
      'word/styles.xml':
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ẩn mặc định</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', docDefaultsHidden)).toMatchObject({ ok: false, code: 'invalid' });

    const docDefaultsVisible = buildDocx({
      'word/styles.xml':
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:vanish w:val="0"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hiển thị bình thường</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', docDefaultsVisible)).toMatchObject({ ok: true, kind: 'docx_to_pdf', pageCount: 1 });
  });

  it('clamps oversized indents, handles footnotes/endnotes warnings & security, bounds paragraph text, handles narrow/tall tables, and emits output_too_large reason', async () => {
    const bigIndent = buildDocx({
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:ind w:left="20000" w:right="4000"/></w:pPr><w:r><w:t>Văn bản lùi lề rất lớn</w:t></w:r></w:p></w:body></w:document>',
    });
    const bigIndentRes = await parse('docx_to_pdf', bigIndent);
    expect(bigIndentRes).toMatchObject({ ok: true, kind: 'docx_to_pdf', warnings: ['complex_columns_simplified'] });

    const separatorOnlyFootnotes = buildDocx({
      'word/footnotes.xml':
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote></w:footnotes>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Không có chú thích</w:t></w:r></w:p></w:body></w:document>',
    });
    const sepRes = await parse('docx_to_pdf', separatorOnlyFootnotes);
    expect(sepRes).toMatchObject({ ok: true, kind: 'docx_to_pdf', warnings: [] });

    const withFootnoteRef = buildDocx({
      'word/footnotes.xml':
        '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Chú thích 1</w:t></w:r></w:p></w:footnote></w:footnotes>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Điều khoản chính</w:t><w:footnoteReference w:id="1"/></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', withFootnoteRef)).toMatchObject({ ok: true, kind: 'docx_to_pdf', warnings: ['footnotes_skipped'] });

    const dirtyEndnotes = buildDocx({
      'word/endnotes.xml':
        '<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1"><w:p><w:ins w:id="1"><w:r><w:t>Ẩn</w:t></w:r></w:ins></w:p></w:endnote></w:endnotes>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Nội dung</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await parse('docx_to_pdf', dirtyEndnotes)).toMatchObject({ ok: false, code: 'invalid' });

    const longPara = buildDocx({
      'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'a'.repeat(MAX_DOCX_PARAGRAPH_CHARS + 1)}</w:t></w:r></w:p></w:body></w:document>`,
    });
    const longParaRes = await parse('docx_to_pdf', longPara);
    expect(longParaRes).toMatchObject({ ok: false, code: 'invalid' });

    const narrowCols = buildDocx({
      'word/document.xml': [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:tbl>',
        '<w:tblGrid><w:gridCol w:w="220"/><w:gridCol w:w="9000"/></w:tblGrid>',
        '<w:tr><w:tc><w:p><w:r><w:t>ABCDEFGHIJKLMNOP</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cột rộng</w:t></w:r></w:p></w:tc></w:tr>',
        '</w:tbl></w:body></w:document>',
      ].join(''),
    });
    expect(await parse('docx_to_pdf', narrowCols)).toMatchObject({ ok: true, kind: 'docx_to_pdf', warnings: [] });

    const tallRowLines = Array.from({ length: 80 }, (_, idx) => `<w:p><w:r><w:t>Dòng bảng rất cao số ${idx + 1}</w:t></w:r></w:p>`).join('');
    const tallRow = buildDocx({
      'word/document.xml': [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:tbl><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>',
        `<w:tr><w:tc>${tallRowLines}</w:tc><w:tc><w:p><w:r><w:t>Cột 2</w:t></w:r></w:p></w:tc></w:tr>`,
        '</w:tbl></w:body></w:document>',
      ].join(''),
    });
    expect(await parse('docx_to_pdf', tallRow)).toMatchObject({
      ok: true,
      kind: 'docx_to_pdf',
      warnings: ['complex_columns_simplified'],
    });

    const tinyDoc = buildDocx({
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OK</w:t></w:r></w:p></w:body></w:document>',
    });
    const saveSpy = vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValue(new Uint8Array(EXTRACT_LIMITS.maxFileBytes + 1));
    try {
      let caught: unknown;
      try {
        await convertDocxToPdf(tinyDoc);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DocxError);
      expect((caught as DocxError).reason).toBe('output_too_large');
      expect(await parse('docx_to_pdf', tinyDoc)).toMatchObject({ ok: false, code: 'too_large' });
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('omits empty spacer blocks for standalone page-break runs without adding EOF blank pages or top-of-page vertical gaps (#4729)', async () => {
    const drawn: Array<{ text: string; x: number; y: number }> = [];
    const origDrawText = PdfFontContext.prototype.drawText;
    const drawSpy = vi.spyOn(PdfFontContext.prototype, 'drawText').mockImplementation(async function (this: PdfFontContext, page, raw, options) {
      drawn.push({ text: raw, x: options.x, y: options.y });
      return origDrawText.call(this, page, raw, options);
    });

    try {
      const docxWithBreaks = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Trang 1</w:t></w:r></w:p>',
          '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
          '<w:p><w:r><w:t>Trang 2</w:t></w:r></w:p>',
          '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const res = await convertDocxToPdf(docxWithBreaks);
      expect(res.pageCount).toBe(2);
      const p1 = drawn.find((d) => d.text === 'Trang 1');
      const p2 = drawn.find((d) => d.text === 'Trang 2');
      expect(p1).toBeDefined();
      expect(p2).toBeDefined();
      expect(p2!.y).toBeCloseTo(p1!.y, 3);

      // Explicit leading w:br type="page" moves content to page 2 (unlike pageBreakBefore on paragraph 1),
      // while trailing explicit break after the last paragraph adds no extra EOF page.
      drawn.length = 0;
      const singleLeadingBreakDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
          '<w:p><w:r><w:t>Sau ngắt đầu</w:t><w:br w:type="page"/></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const leadingRes = await convertDocxToPdf(singleLeadingBreakDocx);
      expect(leadingRes.pageCount).toBe(2);
      expect(drawn.find((d) => d.text === 'Sau ngắt đầu')?.y).toBeCloseTo(p1!.y, 3);

      // w:pageBreakBefore on paragraph 1 plus trailing w:br type="page" yields 1 page total.
      drawn.length = 0;
      const singlePageDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Duy nhất</w:t><w:br w:type="page"/></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const singleRes = await convertDocxToPdf(singlePageDocx);
      expect(singleRes.pageCount).toBe(1);
      expect(drawn.find((d) => d.text === 'Duy nhất')?.y).toBeCloseTo(p1!.y, 3);

      // Consecutive page breaks between content paragraphs preserve an intentional blank page in between.
      drawn.length = 0;
      const doubleBreakDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Trước ngắt đôi</w:t></w:r></w:p>',
          '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
          '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
          '<w:p><w:r><w:t>Sau ngắt đôi</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const doubleBreakRes = await convertDocxToPdf(doubleBreakDocx);
      expect(doubleBreakRes.pageCount).toBe(3);
      expect(drawn.find((d) => d.text === 'Sau ngắt đôi')?.y).toBeCloseTo(p1!.y, 3);

      // Section nextPage followed by w:pageBreakBefore both ask only for a fresh page, so no middle blank page is added.
      drawn.length = 0;
      const sectAndPageBreakBeforeDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>Trang A</w:t></w:r></w:p>',
          '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Trang B</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const sectBreakBeforeRes = await convertDocxToPdf(sectAndPageBreakBeforeDocx);
      expect(sectBreakBeforeRes.pageCount).toBe(2);
      expect(drawn.find((d) => d.text === 'Trang B')?.y).toBeCloseTo(p1!.y, 3);

      // w:pageBreakBefore before a leading w:br w:type="page" in the same paragraph still yields 3 pages (page 2 stays blank).
      drawn.length = 0;
      const beforeAndInlineBreakDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Đầu</w:t></w:r></w:p>',
          '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:br w:type="page"/><w:t>Sau hai ngắt</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const beforeAndInlineRes = await convertDocxToPdf(beforeAndInlineBreakDocx);
      expect(beforeAndInlineRes.pageCount).toBe(3);
      expect(drawn.find((d) => d.text === 'Sau hai ngắt')?.y).toBeCloseTo(p1!.y, 3);

      // An empty paragraph carrying both w:pageBreakBefore and w:sectPr nextPage keeps both breaks (3 pages, middle page blank).
      drawn.length = 0;
      const emptyBothBreaksDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Trước đoạn ngắt</w:t></w:r></w:p>',
          '<w:p><w:pPr><w:pageBreakBefore/><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr></w:p>',
          '<w:p><w:r><w:t>Sau đoạn ngắt</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const emptyBothBreaksRes = await convertDocxToPdf(emptyBothBreaksDocx);
      expect(emptyBothBreaksRes.pageCount).toBe(3);
      expect(drawn.find((d) => d.text === 'Sau đoạn ngắt')?.y).toBeCloseTo(p1!.y, 3);

      // Two explicit page breaks before the first content paragraph leave pages 1-2 blank and place content on page 3.
      drawn.length = 0;
      const leadingDoubleBreakDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:br w:type="page"/><w:br w:type="page"/><w:t>Đầu trang 3</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const leadingDoubleRes = await convertDocxToPdf(leadingDoubleBreakDocx);
      expect(leadingDoubleRes.pageCount).toBe(3);
      expect(drawn.find((d) => d.text === 'Đầu trang 3')?.y).toBeCloseTo(p1!.y, 3);

      // Trailing double explicit break after content preserves 1 blank page between breaks while dropping the extra page after the final break.
      drawn.length = 0;
      const trailingDoubleBreakDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Trang cuối</w:t><w:br w:type="page"/><w:br w:type="page"/></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      const trailingDoubleRes = await convertDocxToPdf(trailingDoubleBreakDocx);
      expect(trailingDoubleRes.pageCount).toBe(2);

      // Plain empty <w:p/> without a page break still preserves intentional vertical spacer height.
      drawn.length = 0;
      const spacerDocx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:r><w:t>Trên</w:t></w:r></w:p>',
          '<w:p/>',
          '<w:p><w:r><w:t>Dưới</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      });
      await convertDocxToPdf(spacerDocx);
      const topY = drawn.find((d) => d.text === 'Trên')!.y;
      const bottomY = drawn.find((d) => d.text === 'Dưới')!.y;
      expect(topY - bottomY).toBeGreaterThan(30);
    } finally {
      drawSpy.mockRestore();
    }
  });

  it('subtracts trimmed trailing whitespace width in flushLine so center and right aligned lines stay aligned (#4729)', async () => {
    const drawn: Array<{ text: string; x: number; y: number }> = [];
    const origDrawText = PdfFontContext.prototype.drawText;
    const drawSpy = vi.spyOn(PdfFontContext.prototype, 'drawText').mockImplementation(async function (this: PdfFontContext, page, raw, options) {
      drawn.push({ text: raw, x: options.x, y: options.y });
      return origDrawText.call(this, page, raw, options);
    });

    try {
      const docx = buildDocx({
        'word/document.xml': [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          '<w:body>',
          '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>CỘNG HÒA</w:t></w:r></w:p>',
          '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">CỘNG HÒA            </w:t><w:tab/></w:r></w:p>',
          '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Bên A</w:t></w:r></w:p>',
          '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Bên A            </w:t><w:tab/></w:r></w:p>',
          '<w:tbl>',
          '  <w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>',
          '  <w:tr>',
          '    <w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Ô bảng</w:t></w:r></w:p></w:tc>',
          '    <w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Ô bảng          </w:t><w:tab/></w:r></w:p></w:tc>',
          '  </w:tr>',
          '</w:tbl>',
          '</w:body></w:document>',
        ].join(''),
      });
      await convertDocxToPdf(docx);

      const centered = drawn.filter((d) => d.text === 'CỘNG HÒA');
      expect(centered).toHaveLength(2);
      expect(centered[1]!.x).toBeCloseTo(centered[0]!.x, 4);

      const rightAligned = drawn.filter((d) => d.text === 'Bên A');
      expect(rightAligned).toHaveLength(2);
      expect(rightAligned[1]!.x).toBeCloseTo(rightAligned[0]!.x, 4);

      const tableCells = drawn.filter((d) => d.text === 'Ô bảng');
      expect(tableCells).toHaveLength(2);
      // Second column starts half a page right of first column, so subtract half CONTENT_WIDTH (241.64 pt).
      expect(tableCells[1]!.x - tableCells[0]!.x).toBeCloseTo((595.28 - 112) / 2, 1);
    } finally {
      drawSpy.mockRestore();
    }
  });
});
