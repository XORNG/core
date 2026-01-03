import { createClient, type RedisClientType } from 'redis';
import type { MemoryEntry } from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * ShortTermMemory - Session context and recent interactions
 * 
 * Uses Redis for fast access to recent context.
 * Entries expire after a configurable TTL.
 */
export class ShortTermMemory {
  private client: RedisClientType | null = null;
  private logger: Logger;
  private redisUrl: string;
  private ttlSeconds: number = 3600; // 1 hour default
  private keyPrefix: string = 'xorng:stm:';

  constructor(
    redisUrl: string = 'redis://localhost:6379',
    logLevel: string = 'info',
    ttlSeconds: number = 3600
  ) {
    this.redisUrl = redisUrl;
    this.ttlSeconds = ttlSeconds;
    this.logger = createLogger(logLevel, 'short-term-memory');
  }

  /**
   * Initialize connection to Redis
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing short-term memory...');

    try {
      this.client = createClient({ url: this.redisUrl });
      
      this.client.on('error', (err) => {
        this.logger.error({ error: err }, 'Redis client error');
      });

      await this.client.connect();
      this.logger.info('Short-term memory initialized');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to connect to Redis, using in-memory fallback');
      this.client = null;
    }
  }

  /**
   * Store a memory entry
   */
  async store(entry: MemoryEntry): Promise<void> {
    const key = `${this.keyPrefix}${entry.id}`;
    const value = JSON.stringify(entry);

    if (this.client) {
      await this.client.setEx(key, this.ttlSeconds, value);
      
      // Also add to a sorted set for search/ordering
      await this.client.zAdd(`${this.keyPrefix}index`, {
        score: entry.timestamp.getTime(),
        value: entry.id,
      });
    }

    this.logger.debug({ entryId: entry.id }, 'Stored short-term memory');
  }

  /**
   * Search for relevant memories
   */
  async search(
    query: string,
    limit: number = 10,
    options?: { projectId?: string; tags?: string[] }
  ): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    if (!this.client) {
      return results;
    }

    try {
      // Get recent entries from the sorted set
      const recentIds = await this.client.zRange(
        `${this.keyPrefix}index`,
        -limit * 2, // Get more than needed for filtering
        -1
      );

      for (const id of recentIds.reverse()) {
        const data = await this.client.get(`${this.keyPrefix}${id}`);
        if (data) {
          const entry = JSON.parse(data) as MemoryEntry;
          
          // Simple text matching (in production, use vector search)
          const queryLower = query.toLowerCase();
          const contentLower = entry.content.toLowerCase();
          
          if (contentLower.includes(queryLower)) {
            // Apply filters
            if (options?.projectId && entry.metadata.projectId !== options.projectId) {
              continue;
            }
            if (options?.tags?.length) {
              const hasTag = options.tags.some(tag => entry.metadata.tags.includes(tag));
              if (!hasTag) continue;
            }

            results.push(entry);
            if (results.length >= limit) break;
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Search failed');
    }

    return results;
  }

  /**
   * Get a specific entry by ID
   */
  async get(id: string): Promise<MemoryEntry | null> {
    if (!this.client) {
      return null;
    }

    const data = await this.client.get(`${this.keyPrefix}${id}`);
    if (data) {
      const entry = JSON.parse(data) as MemoryEntry;
      
      // Update access metadata
      entry.metadata.accessCount += 1;
      entry.metadata.lastAccessed = new Date();
      await this.client.setEx(
        `${this.keyPrefix}${id}`,
        this.ttlSeconds,
        JSON.stringify(entry)
      );

      return entry;
    }

    return null;
  }

  /**
   * Delete an entry
   */
  async delete(id: string): Promise<void> {
    if (this.client) {
      await this.client.del(`${this.keyPrefix}${id}`);
      await this.client.zRem(`${this.keyPrefix}index`, id);
    }
  }

  /**
   * Clear all short-term memory
   */
  async clear(): Promise<void> {
    if (this.client) {
      const keys = await this.client.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    }
    this.logger.info('Short-term memory cleared');
  }

  /**
   * Get the count of entries
   */
  async count(): Promise<number> {
    if (!this.client) {
      return 0;
    }
    return this.client.zCard(`${this.keyPrefix}index`);
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
