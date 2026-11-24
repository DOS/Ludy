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
import { forgetShare } from './lib/social-share.ts';
import { clearRecentItems } from './lib/palette-recents.ts';
import { forgetPushDevice } from './lib/push.ts';
import { stopAndSave } from './lib/recording-controller.ts';
import { auth, captureHostedCallback, discardHostedLogin, loadConfig, settleCallback } from './lib/auth.ts';
import { isInPersonCeremonyIsolated } from './lib/sign-hash.ts';
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
  await settleCallback();
  const { router } = await import('./router.tsx');
  auth().onAuthStateChange((event: string) => {
    if (event === 'SIGNED_OUT' && !isInPersonCeremonyIsolated()) {
      // Signed out here, in another tab or by expiry: a share waiting in this tab is not the next person's.
      forgetShare();
      clearRecentItems();
      // Nor are this browser's push notices (#1238); the session is gone, so only the browser's subscription ends.
      void forgetPushDevice();
      // The session is gone: a recording still running here ends and keeps its copy on the device (the upload cannot go out), so the microphone stops (#3197).
      void stopAndSave({ quiet: true });
      queryClient.clear();
      void router.navigate({ to: '/login' });
    }
  });
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
