import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SUPABASE_URL: z.string().url(), SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20), REDIS_URL: z.string().url().optional(),
  REQUIRE_REDIS: z.string().default('true').transform((v) => v === 'true'),
  CRASH_GAME_ID: z.literal('crash').default('crash'), CRASH_TABLE_ID: z.string().min(1).default('global'),
  ENGINE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
});
export const config = schema.parse(process.env);
export const instanceId = `${process.env.HOSTNAME || 'local'}:${process.pid}:${crypto.randomUUID()}`;
