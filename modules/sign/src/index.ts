// SPDX-License-Identifier: AGPL-3.0-only
// Public entrypoint of @crove/mod-sign (#3323).
export { signCommands, type IssuedSigningLink } from './commands.ts';
export {
  SIGN_EVENT_TYPES,
  appendSigningEvent,
  canonicalJson,
  computeSigningEventHash,
  parseEventPayload,
  sha256Hex,
  verifyEventChain,
  type AppendSigningEventInput,
  type AppendedSigningEvent,
  type SignEventType,
  type SigningEventChainRow,
  type SigningEventHashInput,
  type VerifyEventChainResult,
} from './events.ts';
export { signManifest } from './manifest.ts';
export { signQueries, type SignInspectJobData, type SignSealJobData } from './queries.ts';
export {
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealFields,
  buildPdfSealInputBytes,
  buildPdfSealSigners,
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  maskEmail,
  type CanonicalCertificateArtifactInput,
  type CanonicalCertificateEvent,
  type SignFieldForSeal,
  type SignSignerForSeal,
} from './sealing.ts';
