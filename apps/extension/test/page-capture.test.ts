// SPDX-License-Identifier: AGPL-3.0-only
// Quick Capture & 1-click Web Clipper unit tests (#3560): zero extra permissions for Quick Capture, explicit opt-in
// permissions ('activeTab', 'scripting') gated behind user click, URL scheme validation, and safe HTML-to-Markdown.
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/api.ts';
import { FEATURES } from '../src/features.ts';
import {
  CLIP_BODY_MAX,
  NOTES_CLIP_FEATURE,
  WEB_CLIPPER_PERMISSIONS,
  captureActiveTab,
  capturePage,
  htmlToMarkdown,
  parseTagsInput,
  snapshotDomPage,
  snapshotToClip,
  validateClipUrl,
} from '../src/page-capture.ts';

describe('Quick Capture permissions and API client', () => {
  it('needs zero optional browser permissions for Notes Quick Capture', () => {
    const notesFeature = FEATURES.find((f) => f.id === 'notes');
    expect(notesFeature).toEqual({ id: 'notes', scope: 'notes', permissions: [] });
    expect([...WEB_CLIPPER_PERMISSIONS]).toEqual(['activeTab', 'scripting']);
  });

  it('sends Quick Capture notes and to-dos only to write-only routes with bearer auth and no credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createClient('https://ludy.example', 'crx_notes_1', async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/rpc/notes/clip')) {
        return new Response(JSON.stringify({ json: { noteId: 'note-1', revision: 1 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ json: { todoId: 'todo-1', revision: 1 } }), { status: 200 });
    });

    const clipped = await client.clipNote({
      title: '  Ghi chú nhanh  ',
      body: 'Nội dung mẫu',
      tags: ['họp', 'giao-ban'],
      sourceUrl: 'https://example.com/bai-viet?id=42',
    });
    expect(clipped).toEqual({ noteId: 'note-1', revision: 1 });

    const todo = await client.quickCaptureTodo({
      title: '  Gọi lại khách hàng  ',
      details: 'Trao đổi báo giá',
      dueOn: '2027-02-15',
    });
    expect(todo).toEqual({ todoId: 'todo-1', revision: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://ludy.example/api/rpc/notes/clip');
    expect(calls[1]!.url).toBe('https://ludy.example/api/rpc/notes/todos/quickCapture');
    for (const c of calls) {
      expect(c.init?.method).toBe('POST');
      expect(c.init?.credentials).toBe('omit');
      expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer crx_notes_1');
    }
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      json: {
        title: 'Ghi chú nhanh',
        body: 'Nội dung mẫu',
        tags: ['họp', 'giao-ban'],
        sourceUrl: 'https://example.com/bai-viet?id=42',
      },
    });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      json: {
        title: 'Gọi lại khách hàng',
        details: 'Trao đổi báo giá',
        dueOn: '2027-02-15',
      },
    });
  });

  it('parses and deduplicates tags cleanly within length caps', () => {
    expect(parseTagsInput(' #Hop, khach-hang , hop , ,  ')).toEqual(['hop', 'khach-hang']);
    expect(parseTagsInput('a'.repeat(50) + ', ok')).toEqual(['ok']);
    expect(parseTagsInput(Array.from({ length: 25 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
  });
});

describe('URL validation', () => {
  it('accepts normal http/https URLs and refuses unsafe schemes or embedded credentials', () => {
    expect(validateClipUrl('https://example.com/a/b?q=1#sec')).toBe('https://example.com/a/b?q=1#sec');
    expect(validateClipUrl('http://localhost:8080/page')).toBe('http://localhost:8080/page');
    for (const bad of [
      '',
      '   ',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'chrome://settings',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
      'about:blank',
      'file:///etc/passwd',
      'https://user:secret@example.com/private',
      'https://user@example.com/',
      'https://example.com/\ninjected',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(validateClipUrl(bad), bad).toBeNull();
    }
  });
});

describe('HTML to Markdown conversion and escaping', () => {
  it('converts semantic HTML cleanly while stripping scripts, styles, forms, and nav chrome', () => {
    const html = `
      <nav><a href="/home">Trang chủ</a></nav>
      <article>
        <h1>Báo cáo quý 1 &amp; kế hoạch</h1>
        <p>Đoạn văn với <strong>in đậm</strong>, <em>nghiêng</em> và <code>npm test</code>.</p>
        <blockquote>Trích dẫn quan trọng</blockquote>
        <ul><li>Mục một</li><li>Mục hai với <a href="/docs/1">tài liệu</a></li></ul>
        <ol><li>Bước A</li><li>Bước B</li></ol>
        <pre><code>const total = 100;</code></pre>
        <script>alert('xss')</script>
        <style>body { display: none; }</style>
        <form><input type="password" value="secret"/></form>
      </article>
      <footer>Bản quyền 2027</footer>
    `;
    const md = htmlToMarkdown(html, 'https://example.com/posts/1');
    expect(md).toContain('# Báo cáo quý 1 & kế hoạch');
    expect(md).toContain('Đoạn văn với **in đậm**, *nghiêng* và `npm test`.');
    expect(md).toContain('> Trích dẫn quan trọng');
    expect(md).toContain('- Mục một');
    expect(md).toContain('- Mục hai với [tài liệu](https://example.com/docs/1)');
    expect(md).toContain('1. Bước A');
    expect(md).toContain('2. Bước B');
    expect(md).toContain('```\nconst total = 100;\n```');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('display: none');
    expect(md).not.toContain('secret');
    expect(md).not.toContain('Trang chủ');
    expect(md).not.toContain('Bản quyền 2027');
  });

  it('drops dangerous link schemes, escapes bracket/paren injection, preserves table cells, and handles attr quotes', () => {
    const html = `
      <p>
        <a href="javascript:alert(1)">Click JS</a>
        <a href="data:text/html,hi">Click Data</a>
        <a data-href="https://evil.example/track" href="https://example.com/a(1)/b)">Safe [Label]</a>
      </p>
      <table><tr><td>12</td><td>34</td></tr><tr><td>56</td><td>78</td></tr></table>
      <div title="1 > 0">Visible</div>
    `;
    const md = htmlToMarkdown(html, 'https://example.com/');
    expect(md).toContain('Click JS');
    expect(md).not.toContain('javascript:');
    expect(md).toContain('Click Data');
    expect(md).not.toContain('data:');
    expect(md).not.toContain('evil.example');
    expect(md).toContain('[Safe \\[Label\\]](https://example.com/a%281%29/b%29)');
    expect(md).toContain('12 34\n56 78');
    expect(md).toContain('Visible');
  });

  it('converts large multi-thousand-block HTML in linear time without quadratic slowdown', () => {
    const html = '<p>Sample paragraph content line.</p>'.repeat(5_000);
    const start = performance.now();
    const md = htmlToMarkdown(html, 'https://example.com/');
    const elapsedMs = performance.now() - start;
    expect(md.length).toBeGreaterThan(50_000);
    expect(md.length).toBeLessThanOrEqual(CLIP_BODY_MAX);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('prefers selected HTML when present, falls back to plain text when needed, and respects CLIP_BODY_MAX', () => {
    const selectionClip = snapshotToClip({
      url: 'https://example.com/article',
      title: '  Bài viết   rất dài  ',
      selectedHtml: '<p>Đoạn được chọn</p>',
      selectedText: 'Đoạn được chọn',
      contentHtml: '<p>Toàn bộ trang</p>',
      textFallback: 'Toàn bộ trang',
    });
    expect(selectionClip).toEqual({
      title: 'Bài viết rất dài',
      body: 'Đoạn được chọn',
      sourceUrl: 'https://example.com/article',
    });

    const fallbackClip = snapshotToClip({
      url: 'https://example.com/plain',
      title: '',
      selectedHtml: '',
      selectedText: '',
      contentHtml: '<script>ignored()</script>',
      textFallback: 'x'.repeat(CLIP_BODY_MAX + 500),
    });
    expect(fallbackClip?.title).toBe('example.com');
    expect(fallbackClip?.body.length).toBeLessThanOrEqual(CLIP_BODY_MAX);
    expect(fallbackClip?.body.endsWith('...')).toBe(true);
  });
});

describe('Web Clipper opt-in execution boundary', () => {
  it('refuses when not clicked or optional permissions were not granted, without touching tabs or scripting', async () => {
    const contains = vi.fn(async () => false);
    const query = vi.fn(async () => [{ id: 1, url: 'https://example.com' }]);
    const executeSpy = vi.fn(async () => []);
    const executeScript = executeSpy as unknown as typeof chrome.scripting.executeScript;

    expect(await captureActiveTab({ permissions: { contains }, tabs: { query }, scripting: { executeScript }, clicked: false })).toEqual({
      ok: false,
      reason: 'notClicked',
    });
    expect(contains).not.toHaveBeenCalled();

    expect(await captureActiveTab({ permissions: { contains }, tabs: { query }, scripting: { executeScript }, clicked: true })).toEqual({
      ok: false,
      reason: 'permission',
    });
    expect(contains).toHaveBeenCalledWith({ permissions: ['activeTab', 'scripting'] });
    expect(query).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('refuses internal browser URLs before injecting scripts, and injects snapshotDomPage on click when allowed', async () => {
    const contains = vi.fn(async () => true);
    const executeSpy = vi.fn(async () => [
      {
        result: {
          url: 'https://example.com/doc',
          title: 'Tài liệu',
          selectedHtml: '',
          selectedText: '',
          contentHtml: '<h2>Tổng quan</h2><p>Nội dung sạch</p>',
          textFallback: 'Tổng quan Nội dung sạch',
        },
      },
    ]);
    const executeScript = executeSpy as unknown as typeof chrome.scripting.executeScript;

    const refused = await captureActiveTab({
      permissions: { contains },
      tabs: { query: vi.fn(async () => [{ id: 7, url: 'chrome://extensions' }]) },
      scripting: { executeScript },
      clicked: true,
    });
    expect(refused).toEqual({ ok: false, reason: 'unsupportedUrl' });
    expect(executeSpy).not.toHaveBeenCalled();

    const captured = await captureActiveTab({
      permissions: { contains },
      tabs: { query: vi.fn(async () => [{ id: 9, url: 'https://example.com/doc' }]) },
      scripting: { executeScript },
      clicked: true,
    });
    expect(executeSpy).toHaveBeenCalledWith({ target: { tabId: 9 }, func: snapshotDomPage });
    expect(captured).toEqual({
      ok: true,
      clip: {
        title: 'Tài liệu',
        body: '## Tổng quan\n\nNội dung sạch',
        sourceUrl: 'https://example.com/doc',
      },
    });
  });

  it('maps PageCaptureFeature to notes.note.clip and drops invalid URLs', () => {
    expect(capturePage(NOTES_CLIP_FEATURE, true, () => ({ url: 'javascript:alert(1)', title: '  Demo  ', selectedText: 'Body' }))).toEqual({
      command: 'notes.note.clip',
      input: { title: 'Demo', body: 'Body' },
    });
  });
});
