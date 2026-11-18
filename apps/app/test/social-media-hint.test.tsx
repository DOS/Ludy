// SPDX-License-Identifier: AGPL-3.0-only
// The media field's limits (#3657): the general limit shows always, a platform's own rule only for a channel the post has.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e), fetchFile: () => Promise.reject(new Error('not fetched')), uploadFiles: () => Promise.reject(new Error('not used')) };
});

vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ aiEnabled: false, stockPhotos: false }) }));

const { MediaField } = await import('../src/components/social-media.tsx');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (node: ReactNode) => {
  setActiveLocale('vi');
  return text(
    renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    ),
  );
};
const channel = (id: string, provider: string) => ({ id, provider, displayName: id });

describe('the media limits (#3657)', () => {
  beforeEach(() => client.current.clear());

  it('shows only the general limit with no channel chosen', () => {
    const out = render(<MediaField media={[]} disabled={false} onChange={() => undefined} />);
    expect(out).toContain('Ảnh JPG, PNG hoặc WEBP; video MP4 hoặc MOV đến 100 MB');
    expect(out).not.toContain('Instagram chỉ nhận ảnh JPG');
    expect(out).not.toContain('Zalo OA cần đúng một ảnh');
  });

  it('adds a platform rule only for a channel the post has', () => {
    client.current.setQueryData(['channels', 'list'], [channel('c1', 'instagram'), channel('c2', 'zalo_oa'), channel('c3', 'facebook_page')]);
    const out = render(<MediaField media={[]} disabled={false} connectionIds={['c1']} onChange={() => undefined} />);
    expect(out).toContain('Instagram chỉ nhận ảnh JPG.');
    expect(out).not.toContain('Zalo OA cần đúng một ảnh');
    expect(out).not.toContain('Facebook nhận ảnh đến 4 MB');
  });
});
