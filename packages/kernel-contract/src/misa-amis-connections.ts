// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854): what the Tích hợp card shows and what its commands take. The access code the customer makes in AMIS is sealed in the
// kernel and never in an answer, a log or an audit row; nothing here carries a voucher, a party or MISA's own text, only ids and states.
import { z } from 'zod';
import { zId } from './schemas.ts';

// Whether this deployment offers the connector at all: it does only when the deployment holds the integrator's ClientID (never in any answer).
export const zMisaAmisStatus = z.object({ offered: z.boolean() });
export type MisaAmisStatus = z.infer<typeof zMisaAmisStatus>;

// What a connection test came back with, as a state and never MISA's own text (the column's CHECK).
export const MISA_AMIS_TEST_STATES = ['works', 'wrong_credentials', 'unreachable'] as const;
export const zMisaAmisTestState = z.enum(MISA_AMIS_TEST_STATES);
export type MisaAmisTestState = z.infer<typeof zMisaAmisTestState>;

export const zMisaAmisConnection = z.object({
  id: zId,
  // The channel connection that holds the sealed access code. The code itself is never in any answer.
  connectionId: zId,
  legalEntityId: zId,
  displayName: z.string(),
  status: z.enum(['active', 'expired', 'revoked', 'error']),
  // "Connected since": the only thing the screen shows of the connection's secret side.
  connectedAt: z.iso.datetime({ offset: true }),
  // The last connection test (#3885, S2b): its state and time, or null while none ran.
  lastTestState: zMisaAmisTestState.nullable(),
  lastTestedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type MisaAmisConnection = z.infer<typeof zMisaAmisConnection>;

// The access code the customer made in AMIS (a person with admin rights there): typed once, sealed at the edge and never shown back.
export const MISA_AMIS_ACCESS_CODE_MAX = 500;
export const zMisaAmisConnect = z.strictObject({
  // Left out, the org's default entity.
  legalEntityId: zId.nullable(),
  accessCode: z.string().trim().min(1).max(MISA_AMIS_ACCESS_CODE_MAX),
});
export type MisaAmisConnect = z.infer<typeof zMisaAmisConnect>;

// The command that records a connection test (the worker's alone): a state, nothing else.
export const zMisaAmisConnectionRecordTest = z.strictObject({ id: zId, state: zMisaAmisTestState });
