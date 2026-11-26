// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant guardrails for the signed Windows release pipeline (#4884).
// Self-contained under test/invariant/ with no imports from outside this directory or workspace packages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = fileURLToPath(new URL('../../../../.github/workflows/desktop-package.yml', import.meta.url));
const PACKAGE_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/package.mjs', import.meta.url));

describe('desktop-package workflow guardrails', () => {
  it('runs only via workflow_dispatch from refs/heads/main and gates signing behind desktop-release environment', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const packageScript = readFileSync(PACKAGE_SCRIPT_PATH, 'utf8');

    // Only workflow_dispatch from main is allowed so workflows are always loaded from reviewed main.
    expect(workflow).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(workflow).not.toMatch(/on:[\s\S]*?\n\s*push:/);
    expect(workflow).not.toContain('pull_request_target');

    // Prepare job needs actions: read (not checks: read) and selects the latest matching run on release SHA before checking completion/conclusion.
    expect(workflow).toMatch(/prepare:[\s\S]*?permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read/);
    expect(workflow).not.toContain('checks: read');
    expect(workflow).toContain('--paginate --slurp');
    expect(workflow).toContain('.[].workflow_runs[]');
    expect(workflow).toContain('(.event == "push" or .event == "workflow_dispatch")');
    expect(workflow).toContain('.head_repository.full_name == env.REPO');
    expect(workflow).toContain('[ "$run_status" != \'completed\' ]');
    expect(workflow).toContain('[ "$run_conclusion" != \'success\' ]');
    expect(workflow).toContain("check_workflow_jobs \"$SHA\" '.github/workflows/desktop-build.yml'");

    // Every job must gate on refs/heads/main.
    const mainGates = workflow.match(/github\.ref == 'refs\/heads\/main'/g) ?? [];
    expect(mainGates.length).toBeGreaterThanOrEqual(4);

    // Signing job runs in protected environment and enforces fail-closed --sign packaging.
    expect(workflow).toContain('environment: desktop-release');
    expect(workflow).toContain('node apps/desktop/scripts/package.mjs --version "$env:VERSION" --skip-native --sign');
    expect(workflow).toContain('node apps/desktop/scripts/package.mjs --version "$env:VERSION" --skip-native');

    // Secret-presence check stays early, while ephemeral PFX import runs only after tests/native build and before packaging.
    const secretCheckIdx = workflow.indexOf('name: Validate signing secret presence');
    const unitTestIdx = workflow.indexOf('pnpm exec vitest run --project unit apps/desktop', secretCheckIdx);
    const nativeIdx = workflow.indexOf('node apps/desktop/scripts/build-native.mjs --require-win32', unitTestIdx);
    const stagePfxIdx = workflow.indexOf('name: Stage ephemeral PFX signing certificate');
    const signPkgIdx = workflow.indexOf('node apps/desktop/scripts/package.mjs --version "$env:VERSION" --skip-native --sign');
    expect(secretCheckIdx).toBeGreaterThan(-1);
    expect(unitTestIdx).toBeGreaterThan(secretCheckIdx);
    expect(nativeIdx).toBeGreaterThan(unitTestIdx);
    expect(stagePfxIdx).toBeGreaterThan(nativeIdx);
    expect(signPkgIdx).toBeGreaterThan(stagePfxIdx);
    expect(workflow.slice(secretCheckIdx, unitTestIdx)).not.toContain('Import-PfxCertificate');

    // Both workflow and package.mjs inspect PFX via X509Certificate2Collection, require exactly 1 private-key leaf, and clean up all imported certs.
    for (const [label, src] of [
      ['desktop-package.yml', workflow],
      ['package.mjs', packageScript],
    ] as const) {
      expect(src, label).toContain('X509Certificate2Collection');
      expect(src, label).toContain('$_.HasPrivateKey');
      expect(src, label).toContain('$leaves.Count -ne 1');
      expect(src, label).toContain('Remove-Item -LiteralPath');
      expect(src, label).toContain('-DeleteKey');
      expect(src, label).not.toMatch(/New-Object\s+System\.Security\.Cryptography\.X509Certificates\.X509Certificate2\(/);
    }
    expect(workflow).toContain('WINDOWS_CERT_CLEANUP_THUMBS');
    expect(workflow).toContain('if: always()');

    // Release job must re-verify live tag commit SHA before creating a draft GitHub release.
    expect(workflow).toContain('repos/$REPO/git/ref/tags/$TAG');
    expect(workflow).toContain('gh release create "$TAG" --repo "$REPO" --draft --verify-tag --latest=false');
    expect(workflow).toContain('sha256sum --check SHA256SUMS.txt');

    // Never ship embedded private keys, certificates, or literal base64 PFX blobs in the workflow definition.
    expect(workflow).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(workflow).not.toContain('BEGIN CERTIFICATE');
    expect(workflow).not.toMatch(/WINDOWS_CERT_PFX_BASE64:\s*['"]?[A-Za-z0-9+/=]{16,}/);
    expect(workflow).toContain('${{ secrets.WINDOWS_CERT_PFX_BASE64 }}');

    // Every GitHub Action must be pinned to a full 40-hex commit SHA.
    const usesMatches = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    expect(usesMatches.length).toBeGreaterThan(0);
    for (const ref of usesMatches) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
