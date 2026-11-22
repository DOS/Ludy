// SPDX-License-Identifier: AGPL-3.0-only
// "Do đồng nghiệp AI viết" (#4149): the mark a note, deal, quote or timeline row carries when a connected AI app wrote or changed it (ADR-0051). The kernel stamps the mark from the sealed context of the call,
// so it cannot be missing or forged; the app only says it. The row stays under the name of the person who connected the app, so the mark is how a person tells the coworker's text from that person's own, and
// that it is data to read, not a decision anyone approved. `tainted` is the text's mark and `actorOrigin` the row's: the badge shows when either says an app was involved.
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';

// `showHint` is for a detail view (a deal's sheet, a contact's page), where the sentence fits under the badge: a phone has no hover, so a `title` alone never reaches a touch user. A list row keeps the
// compact badge (its hint stays for a screen reader and a mouse) and the detail one tap away shows the sentence.
//
// `hintId` is for a badge inside a control whose accessible name is its content (the deal board's card, one button): the long hint then must not become part of that name, so it is kept in a hidden element with this
// id, and the control points at it with `aria-describedby` (see `isAiWritten`). The control's name stays short (the label), and the hint is read as its description.
export function AiWrittenBadge({ actorOrigin, tainted = false, className, showHint = false, hintId }: { actorOrigin: 'ui' | 'mcp'; tainted?: boolean; className?: string; showHint?: boolean; hintId?: string }) {
  const t = useTranslations('aiWritten');
  if (actorOrigin !== 'mcp' && !tainted) return null;
  // The text of a row a person made and an app only rewrote says "edited"; a row an app made says "written".
  const wrote = actorOrigin === 'mcp';
  const hint = wrote ? t('hint') : t('hintEdited');
  const badge = (
    <Badge variant="proposal" className={showHint ? undefined : className} title={hint} data-testid="ai-written-badge">
      {wrote ? t('label') : t('labelEdited')}
      {/* The hint also as text a screen reader reaches (a title shows on mouse hover only); a detail view shows it to everyone below. */}
      {!showHint && hintId === undefined && <span className="sr-only">{`. ${hint}`}</span>}
      {!showHint && hintId !== undefined && (
        <span id={hintId} hidden>
          {hint}
        </span>
      )}
    </Badge>
  );
  if (!showHint) return badge;
  return (
    <div className={className ?? 'flex flex-col items-start gap-1'} data-testid="ai-written-note">
      {badge}
      <p className="text-xs text-muted-foreground" data-testid="ai-written-hint">
        {hint}
      </p>
    </div>
  );
}

// Whether the badge shows for a row: the card of a list needs it to point `aria-describedby` at the badge's hint only when there is one.
export const isAiWritten = (actorOrigin: 'ui' | 'mcp', tainted: boolean): boolean => actorOrigin === 'mcp' || tainted;
