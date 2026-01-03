import { z } from 'zod';
import 'dotenv/config';

/**
 * XORNG Configuration Schema
 */
const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3000),
  }),
  redis: z.object({
    url: z.string().url().default('redis://localhost:6379'),
    password: z.string().optional(),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  }),
  tokenTracking: z.object({
    enabled: z.boolean().default(true),
  }),
  subAgents: z.object({
    timeoutMs: z.number().int().positive().default(30000),
    maxConcurrent: z.number().int().positive().default(10),
  }),
  docker: z.object({
    network: z.string().default('xorng-network'),
  }),
});

export type XORNGConfig = z.infer<typeof ConfigSchema>;

/**
 * Load configuration from environment variables
 */
export function loadConfig(): XORNGConfig {
  const rawConfig = {
    server: {
      host: process.env['XORNG_HOST'] || '0.0.0.0',
      port: parseInt(process.env['XORNG_PORT'] || '3000', 10),
    },
    redis: {
      url: process.env['REDIS_URL'] || 'redis://localhost:6379',
      password: process.env['REDIS_PASSWORD'] || undefined,
    },
    logging: {
      level: process.env['LOG_LEVEL'] || 'info',
    },
    tokenTracking: {
      enabled: process.env['ENABLE_TOKEN_TRACKING'] !== 'false',
    },
    subAgents: {
      timeoutMs: parseInt(process.env['SUBAGENT_TIMEOUT_MS'] || '30000', 10),
      maxConcurrent: parseInt(process.env['MAX_CONCURRENT_SUBAGENTS'] || '10', 10),
    },
    docker: {
      network: process.env['DOCKER_NETWORK'] || 'xorng-network',
    },
  };

  return ConfigSchema.parse(rawConfig);
}
