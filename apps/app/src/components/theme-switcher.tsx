import { NavIcon, type NavIconName } from '@ludy/ui/components/nav-icon';
import { SegmentedControl, SegmentedControlItem } from '@ludy/ui/components/segmented-control';
import { useTranslations } from 'use-intl';
import type { ThemeSetting } from '../lib/theme.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeSetting; icon: NavIconName }> = [
  { value: 'light', icon: 'themeLight' },
  { value: 'dark', icon: 'themeDark' },
  { value: 'system', icon: 'themeSystem' },
];

// Compact segmented icon toggle for light, dark or system theme (DESIGN.md 4.6, #4502).
export function ThemeSwitcher({ className }: { className?: string }) {
  const [setting, setSetting] = useThemeSetting();
  const t = useTranslations('common');
  return (
    <SegmentedControl size="sm" value={setting} onValueChange={setSetting} aria-label={t('theme')} className={className}>
      {THEME_OPTIONS.map(({ value, icon }) => {
        const label = t(`themes.${value}`);
        return (
          <SegmentedControlItem key={value} value={value} aria-label={label} title={label}>
            <NavIcon name={icon} />
          </SegmentedControlItem>
        );
      })}
    </SegmentedControl>
  );
}
