import { z } from 'zod';
import { DEPTHS, MODULES } from './domain';

export const preferencesSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  density: z.enum(['comfortable', 'compact']),
  defaultDepth: z.enum(DEPTHS),
  defaultMode: z.enum(['live', 'demo']),
  defaultModules: z.array(z.enum(MODULES)).max(MODULES.length),
  defaultCountry: z.string().regex(/^[A-Z]{2}$/).nullable(),
  retentionDays: z.number().int().min(0).max(3650),
  exportFormat: z.enum(['pdf', 'markdown', 'json', 'csv']),
  redactExports: z.boolean(),
  includeRawEvidence: z.boolean(),
});

export type UserPreferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'system',
  density: 'comfortable',
  defaultDepth: 'standard',
  defaultMode: 'live',
  defaultModules: [],
  defaultCountry: null,
  retentionDays: 0,
  exportFormat: 'pdf',
  redactExports: false,
  includeRawEvidence: false,
};
