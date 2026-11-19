// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { zHrDepartmentEdit } from '@crove/kernel-contract';
import type { CommandContext } from '@crove/kernel-runtime';
import { departmentEdit } from '../src/departments.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const DEPT_ID = '00000000-0000-7000-8000-000000000101';

function buildFakeContext() {
  const audit = vi.fn();
  const setCalls: Record<string, unknown>[] = [];
  const trx = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({
            forUpdate: () => ({
              executeTakeFirst: async () => ({ id: DEPT_ID, archived_at: null }),
            }),
          }),
        }),
      }),
    }),
    updateTable: () => ({
      set: (patch: Record<string, unknown>) => {
        setCalls.push(patch);
        return {
          where: () => ({
            where: () => ({
              execute: async () => [],
            }),
          }),
        };
      },
    }),
  };
  const ctx = {
    orgId: ORG_ID,
    actor: { type: 'user', userId: USER_ID, aal: 'aal1' },
    now: new Date('2026-11-18T10:00:00.000Z'),
    trx,
    audit,
  } as unknown as CommandContext;
  return { ctx, audit, setCalls };
}

describe('hr.department.edit audit changed fields (#3433)', () => {
  it('excludes explicit undefined optional keys from ctx.audit changed list while keeping null clears', async () => {
    const { ctx, audit, setCalls } = buildFakeContext();
    const parsedNameOnly = zHrDepartmentEdit.parse({
      departmentId: DEPT_ID,
      name: 'Kinh doanh B2B',
      code: undefined,
      payFunction: undefined,
    });
    expect(Object.keys(parsedNameOnly)).toEqual(['departmentId', 'name', 'code', 'payFunction']);

    await departmentEdit.handler(ctx, parsedNameOnly);
    expect(setCalls[0]).toEqual({
      name: 'Kinh doanh B2B',
      updated_at: new Date('2026-11-18T10:00:00.000Z'),
    });
    expect(audit).toHaveBeenLastCalledWith({
      departmentId: DEPT_ID,
      changed: ['name'],
    });

    const parsedClearCode = zHrDepartmentEdit.parse({
      departmentId: DEPT_ID,
      name: undefined,
      code: null,
      payFunction: undefined,
    });
    await departmentEdit.handler(ctx, parsedClearCode);
    expect(setCalls[1]).toEqual({
      code: null,
      updated_at: new Date('2026-11-18T10:00:00.000Z'),
    });
    expect(audit).toHaveBeenLastCalledWith({
      departmentId: DEPT_ID,
      changed: ['code'],
    });
  });
});
