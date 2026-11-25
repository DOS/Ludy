import { describe, expect, it } from 'vitest';
import { insertAt } from '../src/lib/social-snippets.ts';

describe('putting a snippet in the text (#584)', () => {
  it('puts it at the cursor, on its own line after other text, and replaces a selection', () => {
    expect(insertAt('', 0, 0, '#ludy')).toEqual({ text: '#ludy', cursor: 5 });
    expect(insertAt('Khai trương', 11, 11, '#ludy')).toEqual({ text: 'Khai trương\n#ludy', cursor: 17 });
    expect(insertAt('Khai trương\n', 12, 12, '#ludy')).toEqual({ text: 'Khai trương\n#ludy', cursor: 17 });
    expect(insertAt('Mở cửa hôm nay', 0, 0, 'Tin vui:')).toEqual({ text: 'Tin vui: Mở cửa hôm nay', cursor: 8 });
    expect(insertAt('Giá XX đồng', 4, 6, '99.000')).toEqual({ text: 'Giá 99.000 đồng', cursor: 10 });
  });
});