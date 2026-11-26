// SPDX-License-Identifier: AGPL-3.0-only
// The screens of the mobile client: sign in, unlock, and home workspace with Approvals and Conversations tabs (issues #4880, #4881, #4882).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { isMfaRequired } from '@ludy/client';
import type { MessageKey } from '../i18n.ts';
import { SERVER_POLICY, clientFor, locale, session, t } from '../runtime.ts';
import { ApprovalsQueueScreen } from '../screens/approvals/ApprovalsQueueScreen.tsx';
import { isLikelyNetworkError } from '../screens/approvals/model.ts';
import { ConversationsInboxScreen } from '../screens/conversations/ConversationsInboxScreen.tsx';
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

export function HomeScreen(props: {
  state: Extract<SessionState, { status: 'active' }>;
  initialTab?: 'approvals' | 'conversations';
  initialConversationId?: string | null;
}) {
  const { serverUrl, orgSlug } = props.state;
  const palette = usePalette();
  const client = useMemo(() => clientFor(serverUrl), [serverUrl]);
  const [pickingOrg, setPickingOrg] = useState(false);
  const [activeTab, setActiveTab] = useState<'approvals' | 'conversations'>(() =>
    props.initialConversationId ? 'conversations' : (props.initialTab ?? 'approvals'),
  );
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(
    props.initialConversationId ?? null,
  );
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  useEffect(() => {
    if (props.initialConversationId) {
      setActiveTab('conversations');
      setPendingConversationId(props.initialConversationId);
    }
  }, [props.initialConversationId]);

  useEffect(() => {
    setUnreadCount(null);
  }, [serverUrl, orgSlug]);

  const me = useQuery({
    queryKey: ['me', serverUrl],
    queryFn: () => client.me.get(),
    refetchInterval: SESSION_CHECK_MS,
  });
  const orgs = me.data?.orgs ?? [];
  const org = orgs.find((o) => o.slug === orgSlug) ?? null;

  const countsQuery = useQuery({
    queryKey: ['home-conversations-unread', serverUrl, org?.slug ?? ''],
    queryFn: () => client.conversations.counts({}),
    enabled: Boolean(org && !pickingOrg),
    retry: false,
    staleTime: 30_000,
  });

  // One org: used without asking. Several: the person picks once, and the choice is kept.
  useEffect(() => {
    if (!orgSlug && orgs.length === 1 && orgs[0]) void session.setOrg(orgs[0].slug);
  }, [orgSlug, orgs]);

  // Network failure fetching user identity before me.get() resolves: show offline error/retry view (user-bound local cache stays locked until userId is confirmed).
  const offlineFallback =
    !org && !pickingOrg && me.isError && !isMfaRequired(me.error) && isLikelyNetworkError(me.error) && orgSlug;

  const activeWorkspace =
    org && !pickingOrg
      ? {
          orgName: org.name,
          orgSlug: org.slug,
          role: org.role,
          canSwitchOrg: orgs.length > 1,
          onSwitchOrg: () => setPickingOrg(true),
          userId: me.data?.userId ?? null,
        }
      : offlineFallback
        ? {
            orgName: orgSlug,
            orgSlug,
            role: 'member' as const,
            canSwitchOrg: false,
            onSwitchOrg: () => setPickingOrg(false),
            userId: null,
          }
        : null;

  if (activeWorkspace) {
    const badgeCount = unreadCount ?? countsQuery.data?.unread ?? 0;
    const conversationsA11y =
      badgeCount > 0
        ? t('tabs.conversationsUnreadA11y', { count: String(badgeCount) })
        : t('tabs.conversations');

    return (
      <View style={{ flex: 1, backgroundColor: palette.background, paddingTop: 12 }}>
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 16,
            paddingBottom: 4,
          }}
        >
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={t('tabs.approvals')}
            accessibilityState={{ selected: activeTab === 'approvals' }}
            onPress={() => setActiveTab('approvals')}
            style={{
              flex: 1,
              minHeight: 48,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: activeTab === 'approvals' ? palette.primary : palette.border,
              backgroundColor: activeTab === 'approvals' ? palette.primary : palette.surface,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 12,
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: '700',
                color: activeTab === 'approvals' ? palette.primaryText : palette.text,
              }}
            >
              {t('tabs.approvals')}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={conversationsA11y}
            accessibilityState={{ selected: activeTab === 'conversations' }}
            onPress={() => setActiveTab('conversations')}
            style={{
              flex: 1,
              minHeight: 48,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: activeTab === 'conversations' ? palette.primary : palette.border,
              backgroundColor: activeTab === 'conversations' ? palette.primary : palette.surface,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingHorizontal: 12,
            }}
          >
            <Text
              style={{
                fontSize: 15,
                fontWeight: '700',
                color: activeTab === 'conversations' ? palette.primaryText : palette.text,
              }}
            >
              {t('tabs.conversations')}
            </Text>
            {badgeCount > 0 ? (
              <View
                style={{
                  minWidth: 22,
                  height: 22,
                  borderRadius: 11,
                  paddingHorizontal: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor:
                    activeTab === 'conversations' ? palette.primaryText : palette.primary,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: '700',
                    color:
                      activeTab === 'conversations' ? palette.primary : palette.primaryText,
                  }}
                >
                  {badgeCount > 99 ? '99+' : String(badgeCount)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        {activeTab === 'approvals' ? (
          <ApprovalsQueueScreen
            key={`approvals:${serverUrl}:${activeWorkspace.orgSlug}`}
            canSwitchOrg={activeWorkspace.canSwitchOrg}
            locale={locale}
            onSwitchOrg={activeWorkspace.onSwitchOrg}
            orgName={activeWorkspace.orgName}
            orgSlug={activeWorkspace.orgSlug}
            role={activeWorkspace.role}
            serverUrl={serverUrl}
            userId={activeWorkspace.userId}
          />
        ) : (
          <ConversationsInboxScreen
            key={`conversations:${serverUrl}:${activeWorkspace.orgSlug}`}
            canSwitchOrg={activeWorkspace.canSwitchOrg}
            initialConversationId={pendingConversationId}
            locale={locale}
            onInitialConversationConsumed={() => setPendingConversationId(null)}
            onSwitchOrg={activeWorkspace.onSwitchOrg}
            onUnreadCountChange={(count) => setUnreadCount(count)}
            orgName={activeWorkspace.orgName}
            orgSlug={activeWorkspace.orgSlug}
            role={activeWorkspace.role}
            serverUrl={serverUrl}
            userId={activeWorkspace.userId}
          />
        )}
      </View>
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
