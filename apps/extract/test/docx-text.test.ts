// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parse.ts';
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

describe('docx_text extraction (#3561)', () => {
  it('extracts paragraphs, tabs, breaks, tables, headers and footers with Vietnamese diacritics', async () => {
    const docx = buildDocx({
      'word/document.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
        '<w:p><w:r><w:t>Hợp đồng dịch vụ &amp; bảo trì</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Khách hàng:</w:t><w:tab/><w:t>Công ty Minh Anh</w:t></w:r><w:del><w:r><w:t>Đã xóa</w:t></w:r></w:del></w:p>',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Mã số</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>HD-2026-88</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        '</w:body></w:document>',
      ].join(''),
      'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Tiêu đề trang</w:t></w:r></w:p></w:hdr>',
      'word/footer1.xml': '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Trang 1</w:t></w:r></w:p></w:ftr>',
    });

    const res = await parse('docx_text', docx);
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'docx_text') {
      expect(res.text).toContain('Hợp đồng dịch vụ & bảo trì');
      expect(res.text).toContain('Khách hàng:\tCông ty Minh Anh');
      expect(res.text).toContain('HD-2026-88');
      expect(res.text).toContain('Tiêu đề trang');
      expect(res.text).toContain('Trang 1');
      expect(res.text).not.toContain('Đã xóa');
    }
  });

  it('refuses DOCTYPE and ENTITY declarations and non-DOCX ZIPs', async () => {
    const xxe = buildDocx({
      'word/document.xml': '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "secret">]><w:document><w:t>&xxe;</w:t></w:document>',
    });
    const r1 = await parse('docx_text', xxe);
    expect(r1).toMatchObject({ ok: false, code: 'invalid' });

    const notDocx = buildZip([{ name: 'hello.txt', data: 'plain zip' }]);
    const r2 = await parse('docx_text', notDocx);
    expect(r2).toMatchObject({ ok: false, code: 'invalid' });
  });
});
