// SPDX-License-Identifier: AGPL-3.0-only
// The generic "capture this page to a command" contract for later features (ADR-0047 point 10; plan section 5.6). It is
// defined here and used by no feature: meetings does not read pages. A feature that uses it would, on the member's click
// only, read the page in front of them (address, title, selected text) and send that to exactly one kernel command it
// names, run as the member in that org, tenant-checked, audited and tainted. It would add `activeTab` and `scripting`
// to the optional permissions when turned on, which the manifest policy then has to list first.
export interface PageCapture {
  // What the click read: nothing else leaves the page.
  page: { url: string; title: string; selectedText: string };
}

export interface PageCaptureFeature {
  id: string;
  // The extension scope and the kernel command this feature's captures go to: exactly one.
  scope: string;
  command: string;
  // Builds the command's input from the captured page. The result is untrusted text (tainted) on the server.
  toInput(capture: PageCapture): Record<string, unknown>;
}

// A feature may only act on a click: the caller passes the evidence of one, and nothing is read without it.
export function capturePage(feature: PageCaptureFeature, clicked: boolean, read: () => PageCapture['page']): { command: string; input: Record<string, unknown> } | null {
  if (!clicked) return null;
  return { command: feature.command, input: feature.toInput({ page: read() }) };
}
