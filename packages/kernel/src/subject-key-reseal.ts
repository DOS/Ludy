// SPDX-License-Identifier: AGPL-3.0-only
// The system command of the reseal pass for subject keys (#2643, ADR-0017 section 7): the worker has wrapped some of an org's subject keys again under the current credential key
// (SubjectVault.rewrap, in the worker's memory), and this writes them, in the org's sealed system context, through the worker-only definer crove_kernel.subject_key_reseal. A write is
// a compare and swap on the key id and the bytes the worker read, so a subject shredded or already resealed in between changes nothing. Only wrapped data keys are in the input:
// no sealed value and no data key. The audit fact carries counts and key ids.
import { sql } from 'kysely';
import { z } from 'zod';
import { tableWrite } from '@crove/kernel-contract';
import { DomainError, defineCommand } from '@crove/kernel-runtime';
import { kernelManifest } from './manifest.ts';

const zKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
// The 60 bytes of a wrapped key (nonce 12 | tag 16 | wrapped data key 32) as base64.
const zWrapped = z.string().regex(/^[A-Za-z0-9+/]{80}$/);
export const SUBJECT_KEY_RESEAL_BATCH = 200;

export const subjectKeyReseal = defineCommand({
  name: 'kernel.subject_key.reseal',
  input: z.strictObject({
    items: z
      .array(z.strictObject({ id: z.uuid(), fromKeyId: zKeyId, fromWrapped: zWrapped, keyId: zKeyId, wrapped: zWrapped }))
      .min(1)
      .max(SUBJECT_KEY_RESEAL_BATCH),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(kernelManifest.tables, 'crove_kernel', 'subject_key', ['key_id', 'wrapped_key'])],
  handler: async (ctx, input): Promise<{ resealed: number; skipped: number }> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới thực hiện được việc này');
    let resealed = 0;
    for (const item of input.items) {
      const { rows } = await sql<{ done: boolean }>`
        SELECT crove_kernel.subject_key_reseal(${item.id}::uuid, ${item.fromKeyId}, decode(${item.fromWrapped}, 'base64'), ${item.keyId}, decode(${item.wrapped}, 'base64')) AS done`.execute(ctx.trx);
      if (rows[0]?.done === true) resealed += 1;
    }
    // Key ids and counts only: they name a key without revealing it.
    ctx.audit({ resealed, unchanged: input.items.length - resealed, from_key_ids: [...new Set(input.items.map((i) => i.fromKeyId))].sort(), key_ids: [...new Set(input.items.map((i) => i.keyId))].sort() });
    return { resealed, skipped: input.items.length - resealed };
  },
});

export const subjectKeyCommands = [subjectKeyReseal];
