// Whether a CSS media query matches now, kept current as the window changes (#1270). A screen that lays out
// differently by width renders one layout, not both with one hidden, so the page holds each element once.
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

// Tailwind's `sm` breakpoint (40rem).
export const SM_UP = '(min-width: 40rem)';

// Wide enough for a list beside its detail (DESIGN.md §3.4, #1514) once the app rail and the menu take their 18rem: a
// 1366 px laptop and up. Below it, list and detail stay separate pages.
export const SPLIT_UP = '(min-width: 84rem)';

// The Engage Inbox's two panes side by side (#3582): the list and the conversation from 80rem (a 1280 px laptop, its content 58rem wide beside the menu);
// below it one pane shows at a time.
export const INBOX_SPLIT_UP = '(min-width: 80rem)';

// How a script scrolls something into view: smoothly, unless the system asks for reduced motion (DESIGN.md §7, #1605).
// The stylesheet's reduced-motion rule cannot reach a scroll whose behavior the script names.
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
