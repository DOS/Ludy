// The product name as a file-name prefix (#1045).
import { describe, expect, it } from 'vitest';
import { brandSlug } from '../src/index.ts';

describe('brandSlug', () => {
  it('gives "ludy" for the default name and spells any other in lower case ASCII with dashes', () => {
    expect(brandSlug('Ludy')).toBe('ludy');
    expect(brandSlug('Tên Mới')).toBe('ten-moi');
    expect(brandSlug('Đại Việt')).toBe('dai-viet');
    expect(brandSlug("Sổ Xanh & Co's (VN)")).toBe('so-xanh-co-s-vn');
  });

  it('falls back to "ludy" when nothing of the name is left', () => {
    expect(brandSlug('...')).toBe('ludy');
    expect(brandSlug('')).toBe('ludy');
  });
});
