/**
 * Load .env files for command-line scripts exactly as Next.js does for the web app (.env, .env.local and the
 * NODE_ENV-specific variants; variables already set in the environment win). Import this first in every script.
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', { info: () => {}, error: console.error });
