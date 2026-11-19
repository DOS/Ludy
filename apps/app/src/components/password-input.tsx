// SPDX-License-Identifier: AGPL-3.0-only
// A password input with a "Show" / "Hide" toggle (#3593, AU-3): on a phone a password typed blind is the main cause of a failed sign-up. The toggle is a
// text button, not an icon, and its name has no word "password" (the field's label gives the context); it is a real button, so it takes the focus after the input and
// is at least 44px high under the phone breakpoint. Hidden again whenever the screen is left (the state lives here, nothing is stored).
import { useState, type ComponentProps } from 'react';
import { useTranslations } from 'use-intl';
import { Input } from '@crove/ui/components/input';

export function PasswordInput({ id, ...props }: Omit<ComponentProps<typeof Input>, 'type'> & { id?: string | undefined }) {
  const t = useTranslations('common');
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} id={id} type={shown ? 'text' : 'password'} className="pr-16" />
      <button
        type="button"
        aria-pressed={shown}
        aria-controls={id}
        onClick={() => setShown((value) => !value)}
        className="absolute right-0 top-1/2 flex min-h-8 min-w-11 -translate-y-1/2 items-center justify-center rounded-lg px-2.5 text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
      >
        {shown ? t('passwordHide') : t('passwordShow')}
      </button>
    </div>
  );
}
