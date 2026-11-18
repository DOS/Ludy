// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox's management of a live launch's objects (ADR-0043, issue #3835, ads W4): it changes the objects a `SandboxAdWriter` holds in memory, so every command of W4
// runs on a laptop and in tests with no network. A status change goes through the writer (pause, archive) and the sandbox's activator (switch on), the same way Meta's does; the
// ad set's budget and end time are kept on the object. It checks the secret and the account the way the writer does, and can be told to fail (the writer's faults of a level:
// `status` fails any change of an object of the level with nothing changed, `status_after` makes the change and loses the answer, `read` fails a read).
import { AdPlatformError } from './index.ts';
import type { AdActivator } from './activators.ts';
import type { AdManager, ManageStatus, ManageTarget, ManagedRead } from './managers.ts';
import type { SandboxAdWriter } from './sandbox-write.ts';
import type { AdWriterAccount } from './writer.ts';

export class SandboxAdManager implements AdManager {
  // The changes it received (a test reads it), in order: what was set on which object.
  readonly changes: Array<{ level: ManageTarget['level']; id: string; set: 'status' | 'budget' | 'end_time'; value: string }> = [];
  private readonly writer: SandboxAdWriter;
  private readonly activator: AdActivator;

  constructor(writer: SandboxAdWriter, activator: AdActivator) {
    this.writer = writer;
    this.activator = activator;
  }

  private object(secret: string, target: ManageTarget) {
    this.writer.checkSecret(secret);
    const found = this.writer.objects.get(target.id);
    if (!found || found.level !== target.level) throw new AdPlatformError('bad_request', 'OBJECT_NOT_FOUND');
    return found;
  }

  async changeStatus(secret: string, target: ManageTarget, status: ManageStatus): Promise<void> {
    this.object(secret, target);
    if (status === 'active') await this.activator.activate(secret, target);
    else await this.writer.setStatus(secret, target, status);
    this.changes.push({ level: target.level, id: target.id, set: 'status', value: status });
    // A pause or an archive is made and the answer is lost: the case the read exists for (the activator takes this fault for a switch-on itself).
    if (status !== 'active') {
      const after = this.writer.takeFault(target.level, 'status_after');
      if (after) throw after.error ?? new AdPlatformError('transient', 'NETWORK');
    }
  }

  private async set(secret: string, target: ManageTarget, set: 'budget' | 'end_time', value: string): Promise<void> {
    const found = this.object(secret, target);
    const before = this.writer.takeFault(target.level, 'status');
    if (before) throw before.error ?? new AdPlatformError('transient', 'NETWORK');
    if (set === 'budget') found.dailyBudget = value;
    else found.endTime = value;
    this.changes.push({ level: target.level, id: target.id, set, value });
    // The change is made and the answer is lost: the case the read exists for.
    const after = this.writer.takeFault(target.level, 'status_after');
    if (after) throw after.error ?? new AdPlatformError('transient', 'NETWORK');
  }

  async setBudget(secret: string, target: ManageTarget, _account: AdWriterAccount, dailyBudget: string): Promise<void> {
    if (!/^(?!0+(\.0+)?$)\d{1,13}(\.\d{1,2})?$/.test(dailyBudget)) throw new AdPlatformError('bad_request', 'BUDGET_INVALID');
    await this.set(secret, target, 'budget', dailyBudget);
  }

  async setEndTime(secret: string, target: ManageTarget, endTime: string): Promise<void> {
    await this.set(secret, target, 'end_time', endTime);
  }

  async read(secret: string, target: ManageTarget, _account: AdWriterAccount): Promise<ManagedRead> {
    const found = this.object(secret, target);
    const fault = this.writer.takeFault(target.level, 'read');
    if (fault) throw fault.error ?? new AdPlatformError('transient', 'NETWORK');
    return { status: found.status === 'active' ? 'active' : found.status === 'archived' ? 'archived' : 'paused', dailyBudget: found.dailyBudget ?? null, endTime: found.endTime ?? null };
  }
}
