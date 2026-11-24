import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { PasswordInput } from '../components/password-input.tsx';
import { ErrorText, Field, Logo, Notice, ScreenTitle, focusFirstInvalid, isEmailAddress, useFieldErrors } from '../components/ui.tsx';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { auth, callbackNoticeText, clearCallbackNotice, getConfig, peekCallbackNotice, type CallbackNotice } from '../lib/auth.ts';
import { screenFailure, screenFailureText, thrownFailure, type ScreenFailure } from '../lib/screen-failure.ts';
import { offeredProviders, providerLabel } from '../lib/auth-providers.ts';
import { startHostedLogin } from '../lib/hosted-login.ts';
import { startOauthLogin } from '../lib/oauth-login.ts';
import { LegalConsent } from '../components/legal-consent.tsx';
import { SupportLink } from '../components/support-link.tsx';

type Mode = 'login' | 'signup' | 'reset';
// The notices the screen shows after sending an email, by message key: state holds no translated text (issue #215).
type SentNotice = 'signupSent' | 'resetSent';

// `initialMode` is for tests; the router renders the page without it.
export function AuthPage({ initialMode = 'login' }: { initialMode?: Mode } = {}) {
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('auth');
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScreenFailure | null>(null);
  const [notice, setNotice] = useState<SentNotice | null>(null);
  // The outcome of an email link the app was opened with, if any (see settleCallback). Kept as a code and worded at
  // render, like the errors above.
  const [callback, setCallback] = useState<CallbackNotice | null>(peekCallbackNotice);
  useEffect(clearCallbackNotice, []);
  // Back from a provider's page restores this screen from the browser's cache with the buttons still busy (#2704).
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  // Checked by the form itself, so each error sits under its field (#1515); the server checks again.
  const fields = useFieldErrors<'email' | 'password'>((field) => {
    if (field === 'email') return !email.trim() ? t('emailRequired') : isEmailAddress(email) ? null : t('emailInvalid');
    return !password ? t('passwordRequired') : password.length < 8 ? t('passwordShort') : null;
  });
  const switchTo = (next: Mode) => {
    fields.reset();
    setMode(next);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.checkAll(mode === 'reset' ? ['email'] : ['email', 'password'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setCallback(null);
    try {
      if (mode === 'login') {
        const { error: e } = await auth().signInWithPassword({ email, password });
        if (e) return setError(screenFailure(e));
        await navigate({ to: '/' });
      } else if (mode === 'signup') {
        const { data, error: e } = await auth().signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/` } });
        if (e) return setError(screenFailure(e));
        if (data.session) await navigate({ to: '/' });
        else setNotice('signupSent');
      } else {
        const { error: e } = await auth().resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
        if (e) return setError(screenFailure(e));
        setNotice('resetSent');
      }
    } catch (thrown) {
      // A call that threw instead of returning an error (the server did not answer).
      setError(thrownFailure(thrown));
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = { login: t('login'), signup: t('signup'), reset: t('reset') };
  // Buttons for the providers the identity provider has enabled (AUTH_OAUTH_PROVIDERS, #2704).
  const providers = offeredProviders(getConfig().authProviders);
  // The identity provider's own sign-in page (#2704, lib/hosted-login.ts), when the deployment has one.
  const hosted = getConfig().hostedLogin ?? null;

  // Leaves for the hosted page with a PKCE challenge; it returns a one-time code that settleCallback redeems.
  async function continueHosted() {
    if (!hosted) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCallback(null);
    try {
      window.location.assign(await startHostedLogin(hosted, { origin: window.location.origin, returnPath: '/', storage: window.sessionStorage }));
    } catch {
      setCallback({ error: true, code: 'hosted_login_failed' });
      setBusy(false);
    }
  }

  // The identity provider's OAuth App as the only way in (AUTH_SIGN_IN=oauth, #4704): no form, no sign-up, no reset.
  const oauthOnly = getConfig().signIn === 'oauth' ? (getConfig().oauthSignIn ?? null) : null;

  // Leaves for the provider's authorize endpoint with a PKCE challenge; it returns a one-time code that settleCallback redeems.
  async function continueOauth() {
    if (!oauthOnly) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCallback(null);
    try {
      window.location.assign(await startOauthLogin(oauthOnly, { origin: window.location.origin, returnPath: '/', storage: window.sessionStorage }));
    } catch {
      setCallback({ error: true, code: 'oauth_login_failed' });
      setBusy(false);
    }
  }

  // Leaves for the provider and comes back with the same one-time code an email link brings (settleCallback exchanges it).
  async function continueWith(provider: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCallback(null);
    try {
      const { error: e } = await auth().signInWithOAuth({ provider: provider as Parameters<ReturnType<typeof auth>['signInWithOAuth']>[0]['provider'], options: { redirectTo: `${window.location.origin}/` } });
      if (e) {
        setError(screenFailure(e));
        setBusy(false);
      }
    } catch (thrown) {
      setError(thrownFailure(thrown));
      setBusy(false);
    }
  }

  if (oauthOnly) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-16">
        <Card className="relative block w-full max-w-sm p-6">
          <div className="flex items-center justify-between gap-2">
            <Logo />
            <LocaleSwitcher />
          </div>
          <ScreenTitle name={titles.login} />
          <h1 className="mt-6 text-lg font-semibold text-foreground">{titles.login}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('tagline')}</p>
          <div className="mt-6 space-y-3">
            {callback?.error && <ErrorText>{callbackNoticeText(callback, root)}</ErrorText>}
            {callback && !callback.error && <Notice>{callbackNoticeText(callback, root)}</Notice>}
            <Button type="button" size="lg" className="min-h-11 w-full" disabled={busy} onClick={() => void continueOauth()}>
              {busy ? root('common.processing') : oauthOnly.name ? t('continueWith', { provider: oauthOnly.name }) : t('continueHosted')}
            </Button>
          </div>
        </Card>
        {/* Help in the same place as on every screen of the app (DESIGN.md §7, 3.2.6; #1516). */}
        <SupportLink className="mt-4 text-sm text-link" />
      </main>
    );
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-16">
      <Card className="relative block w-full max-w-sm p-6">
        <div className="flex items-center justify-between gap-2">
          <Logo />
          <LocaleSwitcher />
        </div>
        <ScreenTitle name={titles[mode]} />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{titles[mode]}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('tagline')}</p>
        <form className="mt-6 space-y-3" noValidate onSubmit={submit}>
          <Field label={t('email')} error={fields.of('email')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  fields.edit('email');
                }}
                onBlur={(e) => fields.blur('email', e.target.value)}
              />
            )}
          </Field>
          {mode !== 'reset' && (
            <Field label={t('password')} hint={mode === 'signup' ? t('passwordHint') : undefined} error={fields.of('password')}>
              {(control) => (
                <PasswordInput
                  {...control}
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    fields.edit('password');
                  }}
                  onBlur={(e) => fields.blur('password', e.target.value)}
                />
              )}
            </Field>
          )}
          {error && <ErrorText>{screenFailureText(error, root)}</ErrorText>}
          {callback?.error && <ErrorText>{callbackNoticeText(callback, root)}</ErrorText>}
          {notice && <Notice>{t(notice)}</Notice>}
          {callback && !callback.error && <Notice>{callbackNoticeText(callback, root)}</Notice>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? root('common.processing') : titles[mode]}
          </Button>
          {mode === 'signup' && <LegalConsent />}
        </form>
        {mode !== 'reset' && (providers.length > 0 || hosted) && (
          <div className="mt-4 space-y-2">
            <p className="text-center text-xs text-muted-foreground">{t('or')}</p>
            {hosted && (
              <Button type="button" variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => void continueHosted()}>
                {hosted.name ? t('continueWith', { provider: hosted.name }) : t('continueHosted')}
              </Button>
            )}
            {providers.map((provider) => (
              <Button key={provider} type="button" variant="outline" size="lg" className="w-full" disabled={busy} onClick={() => void continueWith(provider)}>
                {t('continueWith', { provider: providerLabel(provider) })}
              </Button>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-between text-sm">
          {mode === 'login' ? (
            <>
              <button className="text-link hover:underline" onClick={() => switchTo('signup')}>
                {t('signup')}
              </button>
              <button className="text-subtle-foreground hover:text-muted-foreground" onClick={() => switchTo('reset')}>
                {t('forgotLink')}
              </button>
            </>
          ) : (
            <button className="text-link hover:underline" onClick={() => switchTo('login')}>
              {t('haveAccount')}
            </button>
          )}
        </div>
      </Card>
      {/* Help in the same place as on every screen of the app (DESIGN.md §7, 3.2.6; #1516). */}
      <SupportLink className="mt-4 text-sm text-link" />
    </main>
  );
}
