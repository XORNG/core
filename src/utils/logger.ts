import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Check if pino-pretty is available
 */
function isPinoPrettyAvailable(): boolean {
  try {
    // Dynamic import check - we just need to verify the module exists
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
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
  const usePretty = process.env.NODE_ENV !== 'production' && isPinoPrettyAvailable();

  if (usePretty) {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
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
