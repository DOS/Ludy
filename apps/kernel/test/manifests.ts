// The tables of every module manifest, as the server gives them to its runtime (RuntimeOptions.manifests, #1710,
// #1772): every runtime the kernel's tests build gets them, so declared writes are checked as in production.
import { kernelManifest } from '@crove/kernel';
import type { ManifestTables } from '@crove/kernel-runtime';
import { adsManifest } from '@crove/mod-ads';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { hrManifest } from '@crove/mod-hr';
import { notesManifest } from '@crove/mod-notes';
import { socialManifest } from '@crove/mod-social';
import { meetingsManifest } from '@crove/mod-meetings';
import { projectsManifest } from '@crove/mod-projects';
import { signManifest } from '@crove/mod-sign';

export const TEST_MANIFESTS: readonly ManifestTables[] = [
  kernelManifest,
  financeManifest,
  socialManifest,
  adsManifest,
  crmManifest,
  notesManifest,
  hrManifest,
  meetingsManifest,
  projectsManifest,
  signManifest,
].map((m) => m.tables);
