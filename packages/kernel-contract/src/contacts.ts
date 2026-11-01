// SPDX-License-Identifier: AGPL-3.0-only
// Contacts of the CRM (CRM plan 5 and 6, step K4, #2228): the parties of the org as a list a member searches, filters and
// saves views of, and the command that adds one by hand. A contact is a kernel `party`; nothing here is a new record.
import { z } from 'zod';
import { zFilterAstShape, zSavedViewSortShape } from './saved-view.ts';
import { zId } from './schemas.ts';

export const zPartyKind = z.enum(['organization', 'person']);

// A person or a company by hand (kernel.party.create): validated as kernel.party.update validates its fields.
export const zPartyCreate = z.strictObject({
  kind: zPartyKind,
  name: z.string().max(1000),
  taxCode: z.string().max(40).nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  email: z.string().max(1000).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
});
export type PartyCreate = z.infer<typeof zPartyCreate>;

export const CONTACT_PAGE_DEFAULT = 50;
export const CONTACT_PAGE_MAX = 100;

// A page of the contact list: the view's filter and sort (or an ad-hoc one: the filter bar and the view tabs share this
// input), and the cursor the previous page returned. The filter and sort are checked against the `crm.party` scope of the
// registry (422 otherwise).
export const zContactList = z.strictObject({
  filters: zFilterAstShape.optional(),
  sort: zSavedViewSortShape.nullable().optional(),
  // Opaque: the sort, its direction and the last contact shown with its sort value (a name of 300 characters fits).
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(CONTACT_PAGE_MAX).optional(),
});

export const zContact = z.object({
  id: zId,
  kind: zPartyKind,
  name: z.string(),
  taxCode: z.string().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  // The version an edit sends back (kernel.party.update).
  version: z.number().int(),
  createdAt: z.string(),
});
export type Contact = z.infer<typeof zContact>;

export const zContactPage = z.object({ items: z.array(zContact), next: z.string().nullable() });
export type ContactPage = z.infer<typeof zContactPage>;
