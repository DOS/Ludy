// SPDX-License-Identifier: AGPL-3.0-only
// A channel's optional automations in one closed disclosure (#3656), open from the start when a rule is already set.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdvancedOptions } from '../src/components/social-advanced-options.tsx';

const html = (filled: boolean) =>
  renderToStaticMarkup(
    <AdvancedOptions title="Tùy chọn nâng cao cho Trang A" filled={filled}>
      <p>Gỡ bài lúc</p>
    </AdvancedOptions>,
  );

describe('AdvancedOptions (#3656)', () => {
  it('is closed by default and names the channel in its summary', () => {
    const closed = html(false);
    expect(closed).toContain('<summary');
    expect(closed).toContain('Tùy chọn nâng cao cho Trang A');
    expect(closed).not.toMatch(/<details[^>]* open/);
  });

  it('is open when a rule is already set, so a rule that is on is never hidden', () => {
    expect(html(true)).toMatch(/<details[^>]* open/);
  });
});
