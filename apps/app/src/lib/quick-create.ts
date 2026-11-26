// SPDX-License-Identifier: AGPL-3.0-only
// Universal quick-create `+` actions for the Global Top Bar and mobile shell (#4926):
// filtered strictly by enabled org modules and the caller's role (viewers see no write actions).
import type { NavIconName } from '@ludy/ui/components/nav-icon';
import type { Role } from './members.ts';

export type QuickCreateItemId =
  | 'uploadDocument'
  | 'recordExpense'
  | 'createSalesInvoice'
  | 'quickCapture'
  | 'newTeamTask'
  | 'newNote'
  | 'newContact'
  | 'newDeal'
  | 'newSignEnvelope';

export type QuickCreateTarget =
  | '/o/$slug/inbox'
  | '/o/$slug/vouchers'
  | '/o/$slug/sales-invoices'
  | '/o/$slug/tasks'
  | '/o/$slug/notes'
  | '/o/$slug/contacts'
  | '/o/$slug/deals'
  | '/o/$slug/sign/envelopes';

export type QuickCreateItem =
  | {
      readonly id: 'quickCapture';
      readonly kind: 'action';
      readonly icon: NavIconName;
      readonly shortcut: string;
    }
  | {
      readonly id: Exclude<QuickCreateItemId, 'quickCapture'>;
      readonly kind: 'link';
      readonly to: QuickCreateTarget;
      readonly search?: Readonly<Record<string, string>>;
      readonly icon: NavIconName;
    };

/** Build the ordered quick-create actions visible to the member in the current org. */
export function buildQuickCreateItems(input: {
  modules: readonly string[];
  role: Role | undefined;
  canCreateTeamTask: boolean;
  canQuickCapture: boolean;
}): QuickCreateItem[] {
  const { modules, role, canCreateTeamTask, canQuickCapture } = input;
  if (!role || role === 'viewer') return [];

  const has = (mod: string) => modules.includes(mod);
  const items: QuickCreateItem[] = [];

  if (has('finance')) {
    items.push({ id: 'uploadDocument', kind: 'link', to: '/o/$slug/inbox', icon: 'documents' });
    items.push({
      id: 'recordExpense',
      kind: 'link',
      to: '/o/$slug/vouchers',
      search: { type: 'cash_payment' },
      icon: 'vouchers',
    });
    items.push({ id: 'createSalesInvoice', kind: 'link', to: '/o/$slug/sales-invoices', icon: 'salesInvoices' });
  }
  if (has('notes') && canQuickCapture) {
    items.push({ id: 'quickCapture', kind: 'action', icon: 'myWork', shortcut: 'Alt+Q' });
  }
  if (canCreateTeamTask) {
    items.push({ id: 'newTeamTask', kind: 'link', to: '/o/$slug/tasks', search: { new: '1' }, icon: 'tasks' });
  }
  if (has('notes')) {
    items.push({ id: 'newNote', kind: 'link', to: '/o/$slug/notes', icon: 'notes' });
  }
  if (has('crm')) {
    items.push({ id: 'newContact', kind: 'link', to: '/o/$slug/contacts', icon: 'contacts' });
    items.push({ id: 'newDeal', kind: 'link', to: '/o/$slug/deals', icon: 'deals' });
  }
  if (has('sign')) {
    items.push({ id: 'newSignEnvelope', kind: 'link', to: '/o/$slug/sign/envelopes', icon: 'signEnvelopes' });
  }

  return items;
}

// The jobs Home puts in the thumb row on a phone (#4784), the four of #4783 that a small business does every week
// (Tải chứng từ, Ghi khoản chi, Lập hóa đơn bán, Thêm người liên hệ). A job of an app that is off is never shown, and nothing
// else fills its place: the rest stays in the `+` menu. Links only, so the row is plain navigation.
export const HOME_CREATE_ORDER: readonly Exclude<QuickCreateItemId, 'quickCapture'>[] = ['uploadDocument', 'recordExpense', 'createSalesInvoice', 'newContact'];

export const HOME_CREATE_MAX = 4;

export type QuickCreateLink = Extract<QuickCreateItem, { kind: 'link' }>;

/** The create links of the phone Home row, from the member's own quick-create items (so an app that is off or a viewer's role shows none). */
export function homeCreateItems(items: readonly QuickCreateItem[], max = HOME_CREATE_MAX): QuickCreateLink[] {
  if (max <= 0) return [];
  const links = items.filter((item): item is QuickCreateLink => item.kind === 'link');
  const picked: QuickCreateLink[] = [];
  for (const id of HOME_CREATE_ORDER) {
    const found = links.find((item) => item.id === id);
    if (found) picked.push(found);
    if (picked.length === max) break;
  }
  return picked;
}
