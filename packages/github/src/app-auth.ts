// SPDX-License-Identifier: AGPL-3.0-only
// GitHub App JWT assertion signing via Node crypto RS256 (#5158, ADR-0060 D1).
import { createPrivateKey, createSign } from 'node:crypto';
import { GithubError } from './errors.ts';

const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

// GitHub accepts App JWTs issued up to 60 seconds in the past and expiring within 10 minutes max.
export function createGithubAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const cleanAppId = appId.trim();
  if (!/^[0-9]{1,20}$/.test(cleanAppId) && !/^[A-Za-z0-9_.-]{1,64}$/.test(cleanAppId)) {
    throw new GithubError('credentials', 'GITHUB_APP_ID is malformed');
  }
  const normalizedPem = privateKeyPem.includes('\\n') ? privateKeyPem.replaceAll('\\n', '\n') : privateKeyPem;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(normalizedPem);
  } catch (error) {
    throw new GithubError('credentials', 'GITHUB_APP_PRIVATE_KEY is malformed', { cause: error });
  }
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: cleanAppId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}
