// SPDX-License-Identifier: AGPL-3.0-only
// The keys of the confirmation panel that sends the buyer notice by email (#5257). Escape closes it, as the Close button does, unless the send is under way: the Close button is disabled then, and a panel
// that vanished while the request runs would hide its result and its error.
export const closesNoticeConfirm = (key: string, sending: boolean): boolean => key === 'Escape' && !sending;
