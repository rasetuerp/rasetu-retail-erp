import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().min(1).default('0.0.0.0'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_HOURS: z.coerce.number().positive().default(12),
  // Round 4 — Support Login is validated against Supabase Auth instead of a local
  // Prisma User, so the vendor account can be created/rotated from the Supabase
  // dashboard directly (docs/plan Round 4 design decision #1). Publishable/anon key
  // only — safe to ship, never the service_role key.
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
});

export const env = envSchema.parse(process.env);
