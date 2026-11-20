// SPDX-License-Identifier: AGPL-3.0-only
// The confirmed column mapping (#4037): what the header row alone decides, by the refusal names of the full check (`checkColumnMapping`, #4038), and the contract's list of fields against the
// standard fields of an order line.
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_COLUMN_FIELDS, zMarketplaceColumnsConfirm, type MarketplaceColumnEntry } from '@crove/kernel-contract';
import { ORDER_FIELDS } from '@crove/l10n-vn';
import { checkColumnProfileHeader } from '../src/marketplace-columns.ts';

const col = (index: number, header: string, field: MarketplaceColumnEntry['field']): MarketplaceColumnEntry => ({ index, header, field });
const BASE = [col(0, 'Order ID', 'orderNo'), col(3, 'Quantity', 'quantity'), col(5, 'Product', 'itemName')];

describe('the contract lists the standard fields of an order line', () => {
  it('is the same list, in the same order, as ORDER_FIELDS', () => {
    expect([...MARKETPLACE_COLUMN_FIELDS]).toEqual([...ORDER_FIELDS]);
  });
  it('has no field for buyer data', () => {
    for (const field of MARKETPLACE_COLUMN_FIELDS) expect(field).not.toMatch(/buyer|customer|phone|email|address|recipient/i);
  });
});

describe('checkColumnProfileHeader', () => {
  it('accepts a mapping with the order number and the quantity', () => {
    expect(checkColumnProfileHeader('shopee', BASE)).toBeNull();
  });

  it('refuses a buyer or recipient header, in Vietnamese and in English', () => {
    expect(checkColumnProfileHeader('shopee', [...BASE, col(7, 'Tên người mua', 'variation')])).toBe('buyer_column');
    expect(checkColumnProfileHeader('shopee', [...BASE, col(7, 'Buyer Name', 'variation')])).toBe('buyer_column');
    expect(checkColumnProfileHeader('shopee', [...BASE, col(7, 'shippingCity', 'variation')])).toBe('buyer_column');
  });

  it('refuses a field or a column used twice', () => {
    expect(checkColumnProfileHeader('shopee', [...BASE, col(8, 'Qty again', 'quantity')])).toBe('field_twice');
    expect(checkColumnProfileHeader('shopee', [...BASE, col(3, 'Same place', 'sku')])).toBe('column_twice');
  });

  it('needs the order number', () => {
    expect(checkColumnProfileHeader('shopee', [col(3, 'Quantity', 'quantity'), col(5, 'Product', 'itemName')])).toBe('no_order_no');
  });

  it('needs the quantity, or the line key for a platform whose file has a row per unit', () => {
    const noQuantity = [col(0, 'Order ID', 'orderNo'), col(5, 'Product', 'itemName')];
    expect(checkColumnProfileHeader('shopee', noQuantity)).toBe('no_line');
    // Lazada's file has a row per unit: the line key is what identifies a line there, and a quantity alone does not.
    expect(checkColumnProfileHeader('lazada', BASE)).toBe('no_line');
    expect(checkColumnProfileHeader('lazada', [col(0, 'Order ID', 'orderNo'), col(1, 'Order Item ID', 'lineKey'), col(5, 'Product', 'itemName')])).toBeNull();
  });

  it('reads a return status only with a status', () => {
    expect(checkColumnProfileHeader('shopee', [...BASE, col(9, 'Return', 'returnStatus')])).toBe('return_without_status');
    expect(checkColumnProfileHeader('shopee', [...BASE, col(9, 'Return', 'returnStatus'), col(10, 'Status', 'status')])).toBeNull();
  });
});

describe('the confirmation the command takes', () => {
  const digest = 'a'.repeat(64);
  const ok = { platform: 'shopee', headerRow: 1, columns: BASE, headerDigest: digest };

  it('is a strict object with a platform, the header row, 2 to 13 columns and a hex digest', () => {
    expect(zMarketplaceColumnsConfirm.safeParse(ok).success).toBe(true);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, platform: 'amazon' }).success).toBe(false);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, columns: [BASE[0]] }).success).toBe(false);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, headerDigest: 'not-hex' }).success).toBe(false);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, headerRow: -1 }).success).toBe(false);
  });

  it('refuses a sample, a cell value or any other key next to the mapping', () => {
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, samples: ['9999'] }).success).toBe(false);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, columns: [{ ...BASE[0], sample: 'SP-0001' }, BASE[1]] }).success).toBe(false);
  });

  it('refuses a field outside the standard list and a header cut at 80 characters', () => {
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, columns: [BASE[0], { index: 4, header: 'Buyer', field: 'buyerName' }] }).success).toBe(false);
    expect(zMarketplaceColumnsConfirm.safeParse({ ...ok, columns: [BASE[0], { index: 4, header: 'x'.repeat(81), field: 'sku' }] }).success).toBe(false);
  });
});
