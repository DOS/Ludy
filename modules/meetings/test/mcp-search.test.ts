// SPDX-License-Identifier: AGPL-3.0-only
// The pure part of the Meetings MCP search (#4030): folding, bounding the typed words, matching a line, and cutting the snippet.
import { describe, expect, it } from 'vitest';
import { MCP_SEARCH_WORDS_MAX, MCP_SNIPPET_MAX } from '@crove/kernel-contract';
import { foldQuery, matchLine, snippetAround, tokenize } from '../src/mcp-search.ts';

describe('tokenize', () => {
  it('folds Vietnamese marks, đ and case, and splits on anything that is not a letter or a digit', () => {
    expect(tokenize('Chiết khấu, ĐẶT hàng #12-A!').map((t) => t.word)).toEqual(['chiet', 'khau', 'dat', 'hang', '12', 'a']);
    // A letter written as a base and a mark is the same as the composed letter.
    expect(tokenize('Café Đà Nẵng').map((t) => t.word)).toEqual(['cafe', 'da', 'nang']);
    expect(tokenize('chiê̂́t').map((t) => t.word)).toEqual(['chiet']);
  });

  it('gives the position of each word in the original text', () => {
    const text = 'Họp  giao ban';
    expect(tokenize(text).map((t) => [t.word, text.slice(t.start, t.start + 1)])).toEqual([['hop', 'H'], ['giao', 'g'], ['ban', 'b']]);
  });

  it('treats emoji, controls and bidi marks as separators and survives surrogate pairs', () => {
    expect(tokenize('a😀b‮c\u0000d').map((t) => t.word)).toEqual(['a', 'b', 'c', 'd']);
    const text = '😀 xin chào';
    const t = tokenize(text);
    expect(text.slice(t[0]?.start)).toBe('xin chào');
  });

  it('is fast on a long run of separators and on one long word', () => {
    const started = performance.now();
    expect(tokenize('-'.repeat(100_000))).toEqual([]);
    expect(tokenize('a'.repeat(100_000))).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('foldQuery', () => {
  it('returns the folded words once each, in order', () => {
    expect(foldQuery('Chiết khấu  KHẤU')).toEqual(['chiet', 'khau']);
  });

  it('keeps at most MCP_SEARCH_WORDS_MAX words', () => {
    const q = Array.from({ length: 20 }, (_, i) => `tu${i}`).join(' ');
    expect(foldQuery(q)).toHaveLength(MCP_SEARCH_WORDS_MAX);
  });

  it('is null when nothing can be searched: no word, or only one-character words', () => {
    expect(foldQuery('')).toBeNull();
    expect(foldQuery('!!! ... ---')).toBeNull();
    expect(foldQuery('a b c')).toBeNull();
    expect(foldQuery('😀😀')).toBeNull();
    // One word of two characters is enough, and a one-character word beside it still counts.
    expect(foldQuery('a bc')).toEqual(['a', 'bc']);
  });
});

describe('matchLine', () => {
  it('needs every word to start a word of the line, in any order', () => {
    const line = 'Quyết định giảm chiết khấu cho khách hàng A';
    expect(matchLine(line, ['chiet', 'khau'])).toEqual({ start: line.indexOf('chiết') });
    expect(matchLine(line, ['khach', 'quyet'])).toEqual({ start: 0 });
    expect(matchLine(line, ['chie', 'kh'])?.start).toBe(line.indexOf('chiết'));
  });

  it('is a word PREFIX, not a substring: the middle of a word does not match', () => {
    expect(matchLine('chiết khấu', ['khau'])).toEqual({ start: 6 });
    expect(matchLine('chiết khấu', ['hau'])).toBeNull();
    expect(matchLine('khuyến mãi', ['mai', 'khuyen'])).toEqual({ start: 0 });
  });

  it('is null when one word is missing, and for no words', () => {
    expect(matchLine('giảm giá', ['giam', 'chiet'])).toBeNull();
    expect(matchLine('giảm giá', [])).toBeNull();
    expect(matchLine('', ['a'])).toBeNull();
  });
});

describe('snippetAround', () => {
  it('returns a short line whole', () => {
    expect(snippetAround('Chốt ngân sách quý 1', 5)).toBe('Chốt ngân sách quý 1');
  });

  it('cuts a long line around the match, with ellipses, within the limit', () => {
    const line = `${'x '.repeat(300)}chiết khấu${' y'.repeat(300)}`;
    const at = line.indexOf('chiết');
    const out = snippetAround(line, at);
    expect(out.length).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
    expect(out).toContain('chiết khấu');
    expect(out.startsWith('…') && out.endsWith('…')).toBe(true);
  });

  it('cuts only the end when the match is at the start, and only the start when it is at the end', () => {
    const long = `chiết khấu ${'z '.repeat(300)}`;
    const head = snippetAround(long, 0);
    expect(head.startsWith('chiết')).toBe(true);
    expect(head.endsWith('…')).toBe(true);
    const tail = snippetAround(`${'z '.repeat(300)}chiết khấu`, 600);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('khấu')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });

  it('never splits a surrogate pair', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const line = `${'a'.repeat(250 + pad)}${'😀'.repeat(200)}${'b'.repeat(250)}`;
      for (const start of [0, 100, 255, 400, 600]) {
        const out = snippetAround(line, start);
        expect(out.length).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), `${pad} ${start}`).toBe(false);
      }
    }
  });
});

describe('tokenize speed', () => {
  it('handles the worst case a search can meet (200 meetings of 161 lines of 2,000 characters, 8 words) in a fraction of a second per million characters', () => {
    const line = `${'xin chào các bạn, ngân sách quảng cáo quý một '.repeat(45)}`.slice(0, 2000);
    const words = ['zebra', 'khong', 'co', 'tu', 'nay', 'dau', 'ca', 'luon'];
    const started = performance.now();
    let found = 0;
    for (let i = 0; i < 40; i += 1) for (let j = 0; j < 161; j += 1) if (matchLine(line, words)) found += 1;
    expect(found).toBe(0);
    // 40 x 161 lines of 2,000 characters is 12.9 million characters; a generous bound that still fails on a per-character normalisation of everything.
    expect(performance.now() - started).toBeLessThan(6000);
  });
});
