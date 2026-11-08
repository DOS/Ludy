// SPDX-License-Identifier: AGPL-3.0-only
// The commands of quote acceptance and the sales order (#2696, ADR-0050) are a person's: no agent may run one (the ADR-0029 allowlist is `agent` on a command, and it is absent
// on all of them), each is R1 and internal (nothing posted, no stock moved, nothing sent), and the three that write are the writers' (owners, admins, members), not a viewer's.
import { describe, expect, it } from 'vitest';
import { quoteAccept, quoteDecline, salesOrderCancel, salesOrderCommands, salesOrderGet, salesOrderHandoff, salesOrderList, salesOrderQueries } from '../src/sales-orders.ts';
import { crmCommands, crmQueries } from '../src/index.ts';

describe('the sales order commands', () => {
  it('lists every command and query of the step in the module', () => {
    expect(salesOrderCommands.map((c) => c.name)).toEqual(['crm.quote.accept', 'crm.quote.decline', 'crm.sales_order.cancel']);
    expect(salesOrderQueries.map((q) => q.name)).toEqual(['crm.sales_order.get', 'crm.sales_order.list', 'crm.deal.sales_orders', 'crm.sales_order.handoff']);
    for (const command of salesOrderCommands) expect(crmCommands).toContain(command);
    for (const query of salesOrderQueries) expect(crmQueries).toContain(query);
  });

  it('lets no agent run a command or a query of it', () => {
    for (const unit of [...salesOrderCommands, ...salesOrderQueries]) expect((unit as { agent?: unknown }).agent, unit.name).toBeUndefined();
  });

  it('makes each command R1 and internal, for owners, admins and members only', () => {
    for (const command of [quoteAccept, quoteDecline, salesOrderCancel]) {
      expect(command.risk, command.name).toBe('R1');
      expect(command.sideEffect, command.name).toBe('internal');
      expect([...command.access].sort(), command.name).toEqual(['admin', 'member', 'owner']);
    }
  });

  it('lets everyone read orders, viewers included', () => {
    for (const query of [salesOrderGet, salesOrderList, salesOrderHandoff]) expect([...query.access].sort(), query.name).toEqual(['admin', 'member', 'owner', 'viewer']);
  });
});
