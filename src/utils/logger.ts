import pino from 'pino';
import { createRequire } from 'module';

export type Logger = pino.Logger;

// Create require for ESM context
const require = createRequire(import.meta.url);

/**
 * Get the absolute path to pino-pretty if available
 */
function getPinoPrettyPath(): string | null {
  try {
    return require.resolve('pino-pretty');
  } catch {
    return null;
  }
}

/**
 * Create a logger instance with the specified level
 */
export function createLogger(level: string = 'info', name?: string): Logger {
  const baseOptions: pino.LoggerOptions = {
    level,
    name: name || 'xorng-core',
  };

  // Only use pino-pretty transport if available and not in production
  const pinoPrettyPath = process.env.NODE_ENV !== 'production' ? getPinoPrettyPath() : null;

  if (pinoPrettyPath) {
    return pino({
      ...baseOptions,
      transport: {
        target: pinoPrettyPath,
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  // Default to standard JSON output
  return pino(baseOptions);
}
