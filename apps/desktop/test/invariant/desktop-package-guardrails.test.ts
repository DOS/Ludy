// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant guardrails for the signed Windows release pipeline (#4884).
// Self-contained under test/invariant/ with no imports from outside this directory or workspace packages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = fileURLToPath(new URL('../../../../.github/workflows/desktop-package.yml', import.meta.url));
const BUILD_WORKFLOW_PATH = fileURLToPath(new URL('../../../../.github/workflows/desktop-build.yml', import.meta.url));
const PACKAGE_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/package.mjs', import.meta.url));

function extractYamlRunBlocks(yamlText: string): Array<{ line: number; body: string }> {
  const lines = yamlText.split(/\r?\n/);
  const blocks: Array<{ line: number; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const baseIndent = m[1]!.length;
    const inline = m[2]!.trim();
    if (inline === '|' || inline === '|-' || inline === '|+' || inline === '>' || inline === '>-') {
      const chunk: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]!;
        if (nextLine.trim() === '') {
          chunk.push('');
          continue;
        }
        const indentMatch = /^(\s*)/.exec(nextLine);
        const nextIndent = indentMatch ? indentMatch[1]!.length : 0;
        if (nextIndent <= baseIndent) break;
        chunk.push(nextLine);
        i = j;
      }
      blocks.push({ line: i + 1, body: chunk.join('\n') });
    } else {
      blocks.push({ line: i + 1, body: inline });
    }
  }
  return blocks;
}

describe('desktop-package workflow guardrails', () => {
  it('runs only via workflow_dispatch from refs/heads/main and gates signing behind desktop-release environment', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const packageScript = readFileSync(PACKAGE_SCRIPT_PATH, 'utf8');

    // Only workflow_dispatch from main is allowed so workflows are always loaded from reviewed main.
    expect(workflow).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(workflow).not.toMatch(/on:[\s\S]*?\n\s*push:/);
    expect(workflow).not.toContain('pull_request_target');

    // Prepare job needs actions: read (not checks: read) and pipes gh api --paginate --slurp to standalone jq (never --slurp with --jq).
    expect(workflow).toMatch(/prepare:[\s\S]*?permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read/);
    expect(workflow).not.toContain('checks: read');
    expect(workflow).toContain('--paginate --slurp');
    expect(workflow).not.toMatch(/--slurp[^\n]*--jq/);
    expect(workflow).toContain('.[].workflow_runs[]');
    expect(workflow).toContain('(.event == "push" or .event == "workflow_dispatch")');
    expect(workflow).toContain('.head_repository.full_name == env.REPO');
    expect(workflow).toContain('[ "$run_status" != \'completed\' ]');
    expect(workflow).toContain('[ "$run_conclusion" != \'success\' ]');
    expect(workflow).toContain("check_workflow_jobs \"$SHA\" '.github/workflows/desktop-build.yml'");

    const runsFilterMatch = workflow.match(/WF_PATH="\$workflow_path"\s+jq -r '([^']+)'/);
    const jobsFilterMatch = workflow.match(/jq -r '(\.\[\]\.jobs\[\][^']+)'/);
    expect(runsFilterMatch?.[1]).toContain('sort_by(.created_at) | last');
    expect(jobsFilterMatch?.[1]).toContain('[.name, .status, (.conclusion // "")] | @tsv');

    // Verify paginated multi-page workflow-run selection semantics in pure JS (same rules as the jq filter above).
    const selectLatestRun = (
      pages: Array<{
        workflow_runs: Array<{
          id: number;
          path: string;
          head_branch: string;
          event: string;
          head_repository: { full_name: string };
          status: string;
          conclusion: string | null;
          created_at: string;
        }>;
      }>,
      wfPath: string,
      repo: string,
    ) => {
      const matching = pages
        .flatMap((page) => page.workflow_runs)
        .filter(
          (run) =>
            run.path === wfPath &&
            run.head_branch === 'main' &&
            (run.event === 'push' || run.event === 'workflow_dispatch') &&
            run.head_repository.full_name === repo,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return matching.at(-1) ?? null;
    };
    const picked = selectLatestRun(
      [
        {
          workflow_runs: [
            {
              id: 101,
              path: '.github/workflows/ci.yml',
              head_branch: 'main',
              event: 'push',
              head_repository: { full_name: 'DOS/Ludy' },
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-11-26T10:00:00Z',
            },
            {
              id: 102,
              path: '.github/workflows/ci.yml',
              head_branch: 'main',
              event: 'pull_request',
              head_repository: { full_name: 'fork/Ludy' },
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-11-26T12:00:00Z',
            },
          ],
        },
        {
          workflow_runs: [
            {
              id: 103,
              path: '.github/workflows/ci.yml',
              head_branch: 'main',
              event: 'workflow_dispatch',
              head_repository: { full_name: 'DOS/Ludy' },
              status: 'completed',
              conclusion: 'failure',
              created_at: '2026-11-26T11:00:00Z',
            },
          ],
        },
      ],
      '.github/workflows/ci.yml',
      'DOS/Ludy',
    );
    expect(picked?.id).toBe(103);
    expect(picked?.conclusion).toBe('failure');

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
      expect(src, label).not.toMatch(/\$col\.Import\([^)]*\$secure/);
    }
    expect(workflow).toContain(
      '$col.Import($pfxPath, $env:WINDOWS_CERT_PASSWORD, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)',
    );
    expect(packageScript).toContain(
      '$col.Import($env:LUDY_PFX_FILE, $env:WINDOWS_CERTIFICATE_PASSWORD, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)',
    );
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

  it('enforces macOS dry-run, signed notarization, Keychain cleanup, zero secrets in desktop-build, and no expression injection in run blocks', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const buildWorkflow = readFileSync(BUILD_WORKFLOW_PATH, 'utf8');
    const macSigningScript = readFileSync(fileURLToPath(new URL('../../scripts/macos-signing.mjs', import.meta.url)), 'utf8');
    const macPackageScript = readFileSync(fileURLToPath(new URL('../../scripts/package-mac.mjs', import.meta.url)), 'utf8');

    // desktop-build.yml must build unsigned macOS arm64 + x64 without any secrets and pin all actions to 40-hex SHAs.
    expect(buildWorkflow).toMatch(/\n\s+macos:\s*\n[\s\S]*?runs-on:\s*macos-latest/);
    expect(buildWorkflow).toContain('node apps/desktop/scripts/package-mac.mjs --arch all');
    expect(buildWorkflow).toContain('shasum -a 256 -c SHA256SUMS.txt');
    expect(buildWorkflow).toContain('hdiutil verify "$arch_dir/$dmg"');
    expect(buildWorkflow).not.toContain('secrets.');
    const buildUses = [...buildWorkflow.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    expect(buildUses.length).toBeGreaterThan(0);
    for (const ref of buildUses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }

    // Zero ${{ ... }} expression interpolation inside any run: block in either desktop workflow.
    for (const [label, src] of [
      ['desktop-package.yml', workflow],
      ['desktop-build.yml', buildWorkflow],
    ] as const) {
      const runBlocks = extractYamlRunBlocks(src);
      expect(runBlocks.length, label).toBeGreaterThan(0);
      for (const block of runBlocks) {
        expect(block.body, `${label}:${block.line}`).not.toContain('${{');
      }
    }

    // desktop-package.yml must preserve platform choices, macOS dry-run, and macOS signed gating in desktop-release.
    expect(workflow).toContain('options: [all, windows, macos]');
    expect(workflow).toContain("'macOS build (unsigned, arm64 & x64), tests and size'");
    expect(workflow).toContain('build-mac-dry-run:');
    expect(workflow).toContain('node apps/desktop/scripts/package-mac.mjs --version "$VERSION" --arch all');

    const macSignedIdx = workflow.indexOf('  build-mac-signed:');
    const macSecretCheckIdx = workflow.indexOf('name: Validate macOS signing and notarization secret presence', macSignedIdx);
    const macUnitIdx = workflow.indexOf('pnpm exec vitest run --project unit apps/desktop', macSecretCheckIdx);
    const macStageIdx = workflow.indexOf('name: Stage ephemeral macOS signing certificate and API key', macUnitIdx);
    const macSignPkgIdx = workflow.indexOf('node apps/desktop/scripts/package-mac.mjs --version "$VERSION" --arch all --sign', macStageIdx);
    const macCleanupIdx = workflow.indexOf('name: Clean up ephemeral macOS signing credentials and Keychain', macSignPkgIdx);
    expect(macSignedIdx).toBeGreaterThan(-1);
    expect(macSecretCheckIdx).toBeGreaterThan(macSignedIdx);
    expect(macUnitIdx).toBeGreaterThan(macSecretCheckIdx);
    expect(macStageIdx).toBeGreaterThan(macUnitIdx);
    expect(macSignPkgIdx).toBeGreaterThan(macStageIdx);
    expect(macCleanupIdx).toBeGreaterThan(macSignPkgIdx);

    const macSignedBlock = workflow.slice(macSignedIdx, workflow.indexOf('\n  release:', macSignedIdx));
    expect(macSignedBlock).toContain('environment: desktop-release');
    expect(macSignedBlock).toContain("if: github.ref == 'refs/heads/main'");
    expect(macSignedBlock).toContain('xcrun stapler validate');
    expect(macSignedBlock).toContain('spctl -a -t open --context context:primary-signature -vv');
    expect(macSignedBlock).toContain('if: always()');
    expect(macSignedBlock).toContain('security delete-keychain "$LUDY_MAC_EPHEMERAL_KEYCHAIN"');
    expect(macSignedBlock).toContain('$RUNNER_TEMP/ludy-apple-devid.p12');
    expect(macSignedBlock).toContain('$RUNNER_TEMP/ludy-notary-key.p8');

    // Never ship embedded Apple .p12/.p8 base64 payloads in workflow YAML.
    expect(workflow).not.toMatch(/APPLE_DEVELOPER_ID_CERT_P12_BASE64:\s*['"]?[A-Za-z0-9+/=]{16,}/);
    expect(workflow).not.toMatch(/APPLE_NOTARY_API_KEY_P8_BASE64:\s*['"]?[A-Za-z0-9+/=]{16,}/);

    // Release job waits on both build-signed and build-mac-signed and keeps non-colliding per-arch manifests/checksums.
    expect(workflow).toContain('needs: [prepare, build-signed, build-mac-signed]');
    expect(workflow).toContain('ludy-desktop-signed-darwin');
    expect(workflow).toContain('release-manifest-darwin-${arch}.json');
    expect(workflow).toContain('SHA256SUMS-darwin-${arch}.txt');

    // macOS packaging/signing scripts must never disable continueOnError safety or invoke @electron/notarize with argv passwords.
    expect(macSigningScript).toContain('continueOnError: false');
    expect(macSigningScript).toContain('security');
    expect(macSigningScript).not.toMatch(/['"]--password['"]/);
    expect(macPackageScript).toContain('verifyMacAppBundle');
    expect(macPackageScript).toContain('verifyMacSignedPackage');
  });
});
