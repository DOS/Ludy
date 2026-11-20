// SPDX-License-Identifier: AGPL-3.0-only
// "Do đồng nghiệp AI viết" (#4149): the mark a note, deal, quote or timeline row carries when a connected AI app wrote or changed it (ADR-0051). The kernel stamps the mark from the sealed context of the call,
// so it cannot be missing or forged; the app only says it. The row stays under the name of the person who connected the app, so the mark is how a person tells the coworker's text from that person's own, and
// that it is data to read, not a decision anyone approved. `tainted` is the text's mark and `actorOrigin` the row's: the badge shows when either says an app was involved.
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';

export function AiWrittenBadge({ actorOrigin, tainted = false, className }: { actorOrigin: 'ui' | 'mcp'; tainted?: boolean; className?: string }) {
  const t = useTranslations('aiWritten');
  if (actorOrigin !== 'mcp' && !tainted) return null;
  // The text of a row a person made and an app only rewrote says "edited"; a row an app made says "written".
  const wrote = actorOrigin === 'mcp';
  return (
    <Badge variant="proposal" className={className} title={t('hint')} data-testid="ai-written-badge">
      {wrote ? t('label') : t('labelEdited')}
      {/* The hint also as text a screen reader and a phone reach (a title shows on hover only). */}
      <span className="sr-only">{`. ${wrote ? t('hint') : t('hintEdited')}`}</span>
    </Badge>
  );
}
