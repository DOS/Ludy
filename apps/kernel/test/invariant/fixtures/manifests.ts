// The tables of every module manifest, as the server gives them to its runtime (RuntimeOptions.manifests, #1710,
// #1772): every runtime the invariant suite builds gets them, so declared writes are checked as in production.
import { kernelManifest } from '@ludy/kernel';
import type { ManifestTables } from '@ludy/kernel-runtime';
import { crmManifest } from '@ludy/mod-crm';
import { financeManifest } from '@ludy/mod-finance';
import { hrManifest } from '@ludy/mod-hr';
import { notesManifest } from '@ludy/mod-notes';
import { socialManifest } from '@ludy/mod-social';
import { meetingsManifest } from '@ludy/mod-meetings';
import { projectsManifest } from '@ludy/mod-projects';
import { signManifest } from '@ludy/mod-sign';

export const TEST_MANIFESTS: readonly ManifestTables[] = [kernelManifest, financeManifest, socialManifest, crmManifest, notesManifest, hrManifest, meetingsManifest, projectsManifest, signManifest].map((m) => m.tables);
