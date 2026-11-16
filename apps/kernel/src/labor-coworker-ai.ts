// SPDX-License-Identifier: AGPL-3.0-only
// API orchestrator for the pre-export labor compliance coworker ("Ly", #3372 / #2541 stage 2b-1).
//
// Reads a sanitized snapshot through the audited sensitive query `hr.payroll.labor_check.read` (owner/admin only,
// zero sealed-column decryption, zero MFA step-up required), delegates deterministic + optional pseudonymized
// compliance review to @crove/agent (`reviewLaborCompliance` / `InboxReader.laborCheck`), records an audit row
// `{ kind, checked }` (no PII) via `hr.payroll.labor_check.audit`, and always returns exact deterministic counts
// and findings even when AI is off, over budget, unavailable, or its text is refused.
import { AiBudgetExhaustedError, reviewLaborCompliance, type InboxReader, type LaborComplianceInput, type LaborComplianceResult } from '@crove/agent';
import type { HrLaborCheckAsk, HrLaborCheckKind, HrLaborCheckResult } from '@crove/kernel-contract';
import type { HrLaborCheckSnapshot } from '@crove/mod-hr';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface LaborCheckAi {
  reader: Pick<InboxReader, 'laborCheck'> | null;
  budget: DraftBudget;
}

export interface LaborCheckPorts {
  read(input: HrLaborCheckAsk): Promise<HrLaborCheckSnapshot>;
  record(kind: HrLaborCheckKind, checked: number): Promise<unknown>;
}

/** Runs audited pre-export compliance readiness check for `labor_register` or `01pli`. */
export async function checkLaborReadiness(
  ai: LaborCheckAi,
  ports: LaborCheckPorts,
  orgId: string,
  userId: string,
  input: HrLaborCheckAsk,
): Promise<HrLaborCheckResult> {
  const snapshot = await ports.read(input);
  const language = input.lang ?? 'vi';
  const complianceInput: LaborComplianceInput = {
    kind: snapshot.kind,
    period: snapshot.period,
    asOf: snapshot.asOf,
    language,
    employees: snapshot.employees,
  };
  const displayNames = new Map(snapshot.names.map((n) => [n.employeeId, n.displayName]));

  let result: LaborComplianceResult;
  if (!ai.reader) {
    result = await reviewLaborCompliance(complianceInput, { aiDisabledReason: 'off' });
  } else {
    const ticket = ai.budget.take(orgId, userId);
    if (!ticket.allowed) {
      result = await reviewLaborCompliance(complianceInput, { aiDisabledReason: 'unavailable' });
    } else {
      try {
        result = await ai.reader.laborCheck(complianceInput, {
          forbidden: snapshot.forbidden,
          displayNames,
        });
      } catch (error: unknown) {
        const reason = error instanceof AiBudgetExhaustedError ? 'budget' : 'unavailable';
        console.error('[labor-coworker-ai] check failed', error instanceof Error ? error.name : typeof error);
        result = await reviewLaborCompliance(complianceInput, { aiDisabledReason: reason });
      } finally {
        ticket.release();
      }
    }
  }

  await ports.record(snapshot.kind, result.counts.checked);
  return {
    findings: result.findings.map((finding) => {
      const employeeName = displayNames.get(finding.employeeId);
      return employeeName ? { ...finding, employeeName } : finding;
    }),
    counts: result.counts,
    summary: result.summary,
    notes: result.notes,
    ai: result.ai,
  };
}
