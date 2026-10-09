import 'server-only';
import { env } from './env';

export const UPSTREAM_SOURCE_URL = 'https://github.com/StevePapasot/atlas-osint';

export interface AboutInfo {
  version: string;
  license: string;
  sourceUrl: string;
}

/**
 * Version, license and source location shown in the UI and /api/health. ATLAS is AGPL-3.0: anyone running a modified
 * version for users over a network must offer those users the modified source, so the link is configurable
 * (ATLAS_SOURCE_URL) and defaults to the upstream repository.
 */
export function aboutInfo(): AboutInfo {
  return {
    version: process.env.ATLAS_VERSION ?? '0.0.0',
    license: 'AGPL-3.0',
    sourceUrl: env().ATLAS_SOURCE_URL ?? UPSTREAM_SOURCE_URL,
  };
}
