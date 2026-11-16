// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox's read of an object's state (issue #3301): it answers from the objects a `SandboxAdWriter` holds in memory, so the whole launch and its review states run
// on a laptop and in tests with no network. A test sets what the "platform" says of an object (`effectiveStatus`, `reviewReason`, `deleted`) and can make a read fail.
import { AdPlatformError } from './index.ts';
import type { AdObjectStateSource, StateTarget } from './state-readers.ts';
import type { SandboxAdWriter } from './sandbox-write.ts';

export class SandboxAdStateReader implements AdObjectStateSource {
  // The reads it received (a test reads it): which object.
  readonly reads: StateTarget[] = [];
  private readonly writer: SandboxAdWriter;

  constructor(writer: SandboxAdWriter) {
    this.writer = writer;
  }

  async readState(secret: string, object: StateTarget): Promise<{ status: string; reason: string | null } | null> {
    this.writer.checkSecret(secret);
    this.reads.push({ level: object.level, id: object.id });
    const fault = this.writer.takeFault(object.level, 'state');
    if (fault) throw fault.error ?? new AdPlatformError('transient', 'NETWORK');
    const found = this.writer.objects.get(object.id);
    if (!found || found.level !== object.level || found.deleted === true) return null;
    // What the platform says of an object nobody told otherwise: its own status, in the platform's upper-case words.
    return { status: found.effectiveStatus ?? found.status.toUpperCase(), reason: found.reviewReason ?? null };
  }
}
