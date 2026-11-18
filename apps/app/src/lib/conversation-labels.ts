// SPDX-License-Identifier: AGPL-3.0-only
// The channel and the kind of a conversation on one line (#3636): "Zalo OA · Tin nhắn riêng", but never "Email · Email" for a channel whose name is its kind.
export function channelKindLabel(channelName: string, kindLabel: string): string {
  return channelName.trim().toLocaleLowerCase() === kindLabel.trim().toLocaleLowerCase() ? channelName : `${channelName} · ${kindLabel}`;
}
