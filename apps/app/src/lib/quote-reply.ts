// SPDX-License-Identifier: AGPL-3.0-only
// Where a quote link may be put into a reply (#2827). The link opens a private document (its address is the only secret), so it goes only into a conversation that is
// one customer's own: a direct message or an email thread. A comment thread's reply is public, so the link would be readable by everyone who sees the post. Every kind is
// named here, so a new kind of conversation has to be decided (the unit test lists them all).
import type { ConversationKind } from '@crove/kernel-contract';

const ONE_TO_ONE: Readonly<Record<ConversationKind, boolean>> = { direct: true, email: true, comment_thread: false };

export const canInsertQuoteLink = (kind: ConversationKind): boolean => ONE_TO_ONE[kind];
