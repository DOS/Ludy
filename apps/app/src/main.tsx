import './share-boot.ts';
import './zod-jitless.ts';
import { IconDefaults } from '@ludy/ui/components/icon-defaults';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslations } from 'use-intl';
import { brandName, setBrandName } from './i18n/brand.ts';
import { I18nProvider } from './i18n/provider.tsx';
import { startLocaleSync } from './i18n/runtime.ts';
import { startThemeSync } from './lib/theme-runtime.ts';
import { queryClient } from './lib/api.ts';
import { captureHostedCallback, discardHostedLogin, loadConfig } from './lib/auth.ts';
import { bootWorkspaceAuthSession } from './lib/ceremony-boot.ts';
import './styles.css';

// The hosted login's one-time code leaves the address bar before anything can fail or read it (lib/auth.ts).
captureHostedCallback();
const root = createRoot(document.getElementById('root') as HTMLElement);
startLocaleSync();
startThemeSync();

function ServerUnreachable() {
  const t = useTranslations('common');
  return <p className="p-8 text-sm text-destructive">{t('serverUnreachable')}</p>;
}

async function start() {
  try {
    // The product name (issue #1040) fills every message from the first render on; index.html says "Ludy" until then.
    setBrandName((await loadConfig()).brandName);
    document.title = brandName();
  } catch {
    discardHostedLogin();
    root.render(
      <IconDefaults>
        <I18nProvider>
          <ServerUnreachable />
        </I18nProvider>
      </IconDefaults>,
    );
    return;
  }
  let routerModule: typeof import('./router.tsx') | null = null;
  await bootWorkspaceAuthSession({
    prepareNavigation: async () => {
      routerModule = await import('./router.tsx');
      return () => void routerModule!.router.navigate({ to: '/login' });
    },
  });
  const { router } = routerModule ?? (await import('./router.tsx'));
  root.render(
    <StrictMode>
      <IconDefaults>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </I18nProvider>
      </IconDefaults>
    </StrictMode>,
  );
}

void start();
