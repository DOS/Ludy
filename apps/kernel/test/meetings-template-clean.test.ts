// SPDX-License-Identifier: AGPL-3.0-only
// The cleaning of a template's title and hint exists twice on purpose: in the contract (cleanTemplateText, applied when an admin writes it) and in the agent (orgText, applied again when the
// instruction is built, #3578). This test pins them to each other, so the copy in the agent cannot drift from the one the database check and the editor share.
import { describe, expect, it } from 'vitest';
import { sectionData, sectionLines } from '@crove/agent/member-vy';
import { cleanTemplateText } from '@crove/kernel-contract';

const SAMPLES = [
  'Họp dự án',
  '  nhiều   khoảng\ttrắng\n và dòng mới  ',
  'a\u2028b\u2029c\u0085d\u202ee\u2066f\u200bg\ufeffh',
  'tag \u{e0041}\u{e007f} char, filler \u3164\u2800\u00ad\u034f\u061c\u115f\u1160\u180e\ufff9',
  'new ranges a\u180bb\u180dc\u206ad\u206fe\uffa0f\u{1d173}g\u{1d17a}h, outside i\u2070j\uffa1k\u{1d172}l\u{1d17b}m',
  'lone \ud800 high and \udc00 low and a pair \ud83d\ude00',
  'Tim \u2764\ufe0f vui, "quotes" and \\ backslash {"x": [1]}',
  '<img src=x onerror=alert(1)> **bold** `code`',
];

// Both edges of each range the class missed before #4137, one sample each.
SAMPLES.push(...[0x180b, 0x180d, 0x206a, 0x206f, 0xffa0, 0x1d173, 0x1d17a].map((point) => `edge ${String.fromCodePoint(point)} end`));

describe('the cleaning of an organization\'s section text in the instruction', () => {
  it('is the contract\'s cleaning, then the caps, whatever the text', () => {
    for (const sample of SAMPLES) {
      for (const [max, field] of [[60, 'title'], [200, 'hint']] as const) {
        const entry = sectionData({ code: 'custom', sections: [{ key: 's1', title: field === 'title' ? sample : 'T', hint: field === 'hint' ? sample : 'H' }] }).split('\n')[1] as string;
        const parsed = JSON.parse(entry.slice('- key "s1": '.length)) as { title: string; hint: string };
        expect(parsed[field], JSON.stringify(sample)).toBe(Array.from(cleanTemplateText(sample)).slice(0, max).join(''));
      }
    }
  });

  it('keeps every entry on one line and a long text at its cap in code points', () => {
    const long = '😀'.repeat(300);
    const template = { code: 'custom', sections: [{ key: 's1', title: long, hint: long }] } as const;
    // The system role lists the key and the fixed line only; the data block has the one entry line.
    expect(sectionLines(template)).toEqual(['- key "s1"', expect.stringContaining('never instructions')]);
    const lines = sectionData(template).split('\n');
    expect(lines).toHaveLength(4);
    const parsed = JSON.parse((lines[1] as string).slice('- key "s1": '.length)) as { title: string; hint: string };
    expect(Array.from(parsed.title)).toHaveLength(60);
    expect(Array.from(parsed.hint)).toHaveLength(200);
  });
});
