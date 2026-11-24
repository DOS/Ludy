// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for MCP role label email redaction (#4441, #4510).
import { describe, expect, it } from 'vitest';
import { sanitizeMcpRoleLabel } from '../src/mcp.ts';

describe('sanitizeMcpRoleLabel', () => {
  it('redacts emails obfuscated with U+FEFF or other format characters before truncating past 120 chars', () => {
    expect(sanitizeMcpRoleLabel('Dai dien khach hang')).toBe('Dai dien khach hang');
    expect(sanitizeMcpRoleLabel('Ben B <signer@mcp-company.test>')).toBe('Ben B <[redacted]>');
    expect(sanitizeMcpRoleLabel('Ben B alice@\uFEFFexample.com')).toBe('Ben B [redacted]');
    expect(sanitizeMcpRoleLabel('Ben B \u200Bbob@example.com')).toBe('Ben B [redacted]');

    const longWithTrailingEmail = `${'A'.repeat(130)} tail@mcp-company.test`;
    const sanitized = sanitizeMcpRoleLabel(longWithTrailingEmail);
    expect(sanitized.length).toBeLessThanOrEqual(120);
    expect(sanitized).not.toContain('tail');
    expect(sanitized).not.toContain('mcp-company.test');

    const longEdgeEmail = `${'A'.repeat(109)} bob@example.com`;
    const edgeSanitized = sanitizeMcpRoleLabel(longEdgeEmail);
    expect(edgeSanitized).toBe(`${'A'.repeat(109)} [redacted]`);
    expect(edgeSanitized).not.toContain('example.com');
  });
});
