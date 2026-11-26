// SPDX-License-Identifier: AGPL-3.0-only
// The root of the app: which screen the session state calls for, and the rules that follow the phone's own events (issue #4880).
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { shouldAutoLock } from './auth/auto-lock.ts';
import { approvalsCache, queryClient, session, stepUp } from './runtime.ts';
import { HomeScreen, LockScreen, SignInScreen } from './ui/screens.tsx';
import { usePalette } from './ui/theme.ts';

export default function App() {
  const state = useSyncExternalStore(session.subscribe, session.state);
  const palette = usePalette();
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    void session.start();
  }, []);

  // Locks after a while in the background, and forgets everything a lock or a sign-out should: the step-up confirmation and the
  // cached answers of the server (they belong to the person who was signed in).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') backgroundedAt.current = Date.now();
      if (next === 'active') {
        if (shouldAutoLock(backgroundedAt.current, Date.now())) session.lock();
        backgroundedAt.current = null;
      }
    });
    return () => subscription.remove();
  }, []);
  const activeScope = state.status === 'active' ? `${state.serverUrl}|${state.orgSlug ?? ''}` : null;
  const previousScope = useRef<string | null>(activeScope);

  useEffect(() => {
    if (state.status !== 'active') {
      stepUp.reset();
      previousScope.current = null;
    } else {
      if (previousScope.current !== null && previousScope.current !== activeScope) {
        stepUp.reset();
      }
      previousScope.current = activeScope;
    }
    if (state.status === 'signed-out') {
      queryClient.clear();
      void approvalsCache.clear();
    }
  }, [state.status, activeScope]);

  return (
    <QueryClientProvider client={queryClient}>
      {state.status === 'loading' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.background }}>
          <ActivityIndicator />
        </View>
      ) : state.status === 'signed-out' ? (
        <SignInScreen notice={state.notice} />
      ) : state.status === 'locked' ? (
        <LockScreen />
      ) : (
        <HomeScreen state={state} />
      )}
    </QueryClientProvider>
  );
}
