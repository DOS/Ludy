// SPDX-License-Identifier: AGPL-3.0-only
// The three screens of the mobile client: sign in, unlock, and home approvals queue (issues #4880, #4881).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, TextInput } from 'react-native';
import { isMfaRequired } from '@ludy/client';
import type { MessageKey } from '../i18n.ts';
import { SERVER_POLICY, clientFor, locale, session, t } from '../runtime.ts';
import { ApprovalsQueueScreen } from '../screens/approvals/ApprovalsQueueScreen.tsx';
import { isLikelyNetworkError } from '../screens/approvals/model.ts';
import { Body, LinkButton, PrimaryButton, Screen, Title } from './parts.tsx';
import { styles, usePalette } from './theme.ts';
import type { SessionState } from '../auth/session.ts';

const ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  'unsupported-server': 'signIn.error.unsupported-server',
  'server-unreachable': 'signIn.error.server-unreachable',
  'no-device-lock': 'signIn.error.no-device-lock',
  cancelled: 'signIn.error.cancelled',
  storage: 'signIn.error.storage',
};

export function SignInScreen(props: { notice: 'revoked' | 'expired' | null }) {
  const palette = usePalette();
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const noticeKey: MessageKey | null = props.notice === 'revoked' ? 'signIn.notice.revoked' : props.notice === 'expired' ? 'signIn.notice.expired' : null;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const result = await session.signIn(SERVER_POLICY.kind === 'cloud' ? SERVER_POLICY.url : server);
    setBusy(false);
    // On success the state changes and this screen goes away.
    if (!result.ok) setError(ERROR_KEYS[result.reason] ?? 'signIn.error.generic');
  };

  return (
    <Screen>
      <Title>{t('signIn.title')}</Title>
      <Body>{t('signIn.lead')}</Body>
      {noticeKey ? <Body tone="danger">{t(noticeKey)}</Body> : null}
      {SERVER_POLICY.kind === 'custom' ? (
        <>
          <Text accessibilityRole="text" style={[styles.body, { color: palette.text }]}>
            {t('signIn.server')}
          </Text>
          <TextInput
            accessibilityLabel={t('signIn.server')}
            value={server}
            onChangeText={setServer}
            placeholder="https://"
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            style={[styles.input, { borderColor: palette.border, color: palette.text }]}
          />
          <Body tone="muted">{t('signIn.serverHint')}</Body>
        </>
      ) : null}
      {error ? <Body tone="danger">{t(error)}</Body> : null}
      <PrimaryButton label={busy ? t('signIn.working') : t('signIn.button')} busy={busy} onPress={() => void signIn()} />
    </Screen>
  );
}

export function LockScreen() {
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  const unlock = async () => {
    setBusy(true);
    setOffline(false);
    const result = await session.unlock();
    setBusy(false);
    if (!result.ok && result.reason === 'offline') setOffline(true);
  };

  // The prompt opens by itself when the screen appears; the button asks again after a cancel.
  useEffect(() => {
    void unlock();
  }, []);

  return (
    <Screen>
      <Title>{t('lock.title')}</Title>
      <Body>{t('lock.lead')}</Body>
      {offline ? <Body tone="danger">{t('lock.offline')}</Body> : null}
      <PrimaryButton label={busy ? t('lock.working') : t('lock.button')} busy={busy} onPress={() => void unlock()} />
      <LinkButton label={t('lock.signOut')} onPress={() => void session.signOut()} />
    </Screen>
  );
}

// How often the home screen asks the server who this session is. A session revoked on the server ends with the first answer
// that says so: the phone is signed out within this time, or at once on the next tap.
export const SESSION_CHECK_MS = 5 * 60_000;

export function HomeScreen(props: { state: Extract<SessionState, { status: 'active' }> }) {
  const { serverUrl, orgSlug } = props.state;
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);
  const [pickingOrg, setPickingOrg] = useState(false);

  const me = useQuery({
    queryKey: ['me', serverUrl],
    queryFn: () => client.me.get(),
    refetchInterval: SESSION_CHECK_MS,
  });
  const orgs = me.data?.orgs ?? [];
  const org = orgs.find((o) => o.slug === orgSlug) ?? null;

  // One org: used without asking. Several: the person picks once, and the choice is kept.
  useEffect(() => {
    if (!orgSlug && orgs.length === 1 && orgs[0]) void session.setOrg(orgs[0].slug);
  }, [orgSlug, orgs]);

  if (org && !pickingOrg) {
    return (
      <ApprovalsQueueScreen
        key={`${serverUrl}:${org.slug}`}
        canSwitchOrg={orgs.length > 1}
        locale={locale}
        onSwitchOrg={() => setPickingOrg(true)}
        orgName={org.name}
        orgSlug={org.slug}
        role={org.role}
        serverUrl={serverUrl}
        userId={me.data?.userId ?? null}
      />
    );
  }

  // Offline launch with an already-selected org: let the queue show its persisted local cache as read-only preview.
  if (me.isError && !isMfaRequired(me.error) && isLikelyNetworkError(me.error) && orgSlug && !pickingOrg) {
    return (
      <ApprovalsQueueScreen
        key={`${serverUrl}:${orgSlug}`}
        canSwitchOrg={false}
        locale={locale}
        onSwitchOrg={() => setPickingOrg(false)}
        orgName={orgSlug}
        orgSlug={orgSlug}
        role="member"
        serverUrl={serverUrl}
        userId={null}
      />
    );
  }

  return (
    <Screen>
      {me.isPending ? (
        <>
          <ActivityIndicator accessibilityLabel={t('home.loading')} />
          <Body tone="muted">{t('home.loading')}</Body>
        </>
      ) : me.isError ? (
        <>
          <Body tone="danger">{isMfaRequired(me.error) ? t('home.error.mfa') : t('home.error.generic')}</Body>
          <PrimaryButton label={t('home.retry')} onPress={() => void me.refetch()} />
        </>
      ) : (
        <>
          <Title>{t('home.title', { name: me.data.displayName ?? me.data.email })}</Title>
          {orgs.length === 0 ? <Body>{t('home.noOrg')}</Body> : null}
          {orgs.length > 1 || (orgs.length === 1 && !org) ? (
            <>
              <Body>{t('home.pickOrg')}</Body>
              {orgs.map((o) => (
                <PrimaryButton
                  key={o.slug}
                  label={o.name}
                  onPress={() => {
                    void session.setOrg(o.slug);
                    setPickingOrg(false);
                  }}
                />
              ))}
              {pickingOrg && org ? (
                <LinkButton label={t('approvals.back')} onPress={() => setPickingOrg(false)} />
              ) : null}
            </>
          ) : null}
        </>
      )}
      <LinkButton label={t('home.signOut')} onPress={() => void session.signOut()} />
      <Body tone="muted">{t('home.signOutHint')}</Body>
    </Screen>
  );
}
