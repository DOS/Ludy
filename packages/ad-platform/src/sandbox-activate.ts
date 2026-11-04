// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox's activation (ADR-0043 points 4 and 5, issue #2296, W2-4b): it switches on an object the sandbox writer holds in memory, so the whole launch runs on a
// laptop and in tests with no network. It works on the objects of one `SandboxAdWriter` (the process's, or a test's own with its faults), checks the secret and the account
// the way the writer does, and can be told to fail, so a test can kill a launch between the change and its record.
import { AdPlatformError } from './index.ts';
import type { ActivateTarget, AdActivator, PlatformObjectStatus } from './activators.ts';
import type { SandboxAdWriter } from './sandbox-write.ts';

export class SandboxAdActivator implements AdActivator {
  // The changes it received (a test reads it): which object was switched on.
  readonly changes: Array<{ level: ActivateTarget['level']; id: string }> = [];
  private readonly writer: SandboxAdWriter;

  constructor(writer: SandboxAdWriter) {
    this.writer = writer;
  }

  async activate(secret: string, object: ActivateTarget): Promise<void> {
    this.writer.checkSecret(secret);
    const found = this.writer.objects.get(object.id);
    if (!found || found.level !== object.level) throw new AdPlatformError('bad_request', 'OBJECT_NOT_FOUND');
    const before = this.writer.takeFault(object.level, 'status');
    if (before) throw before.error ?? new AdPlatformError('transient', 'NETWORK');
    found.status = 'active';
    this.changes.push({ level: object.level, id: object.id });
    // The change is made and the answer is lost: the case the read of the status exists for.
    const after = this.writer.takeFault(object.level, 'status_after');
    if (after) throw after.error ?? new AdPlatformError('transient', 'NETWORK');
  }

  async readStatus(secret: string, object: ActivateTarget): Promise<{ status: PlatformObjectStatus }> {
    this.writer.checkSecret(secret);
    const fault = this.writer.takeFault(object.level, 'read');
    if (fault) throw fault.error ?? new AdPlatformError('transient', 'NETWORK');
    const found = this.writer.objects.get(object.id);
    if (!found || found.level !== object.level) throw new AdPlatformError('bad_request', 'OBJECT_NOT_FOUND');
    return { status: found.status === 'active' ? 'active' : found.status === 'archived' ? 'archived' : 'paused' };
  }
}
