import { createClient, type RedisClientType } from 'redis';
import type { MemoryEntry } from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * LongTermMemory - Persistent pattern storage
 * 
 * Stores successful patterns, learned optimizations, and past mistakes.
 * Entries do not expire and are persisted across sessions.
 */
export class LongTermMemory {
  private client: RedisClientType | null = null;
  private logger: Logger;
  private redisUrl: string;
  private keyPrefix: string = 'xorng:ltm:';

  constructor(
    redisUrl: string = 'redis://localhost:6379',
    logLevel: string = 'info'
  ) {
    this.redisUrl = redisUrl;
    this.logger = createLogger(logLevel, 'long-term-memory');
  }

  /**
   * Initialize connection to Redis
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing long-term memory...');

    try {
      this.client = createClient({ url: this.redisUrl });
      
      this.client.on('error', (err) => {
        this.logger.error({ error: err }, 'Redis client error');
      });

      await this.client.connect();
      this.logger.info('Long-term memory initialized');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to connect to Redis, using in-memory fallback');
      this.client = null;
    }
  }

  /**
   * Store a memory entry (permanent storage)
   */
  async store(entry: MemoryEntry): Promise<void> {
    const key = `${this.keyPrefix}${entry.id}`;
    const value = JSON.stringify(entry);

    if (this.client) {
      // No expiration for long-term memory
      await this.client.set(key, value);
      
      // Add to sorted set by relevance for prioritized retrieval
      await this.client.zAdd(`${this.keyPrefix}index:relevance`, {
        score: entry.metadata.relevance,
        value: entry.id,
      });

      // Add to set by tags for filtering
      for (const tag of entry.metadata.tags) {
        await this.client.sAdd(`${this.keyPrefix}tags:${tag}`, entry.id);
      }

      // Add to project index if applicable
      if (entry.metadata.projectId) {
        await this.client.sAdd(
          `${this.keyPrefix}project:${entry.metadata.projectId}`,
          entry.id
        );
      }
    }

    this.logger.debug({ entryId: entry.id }, 'Stored long-term memory');
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
      let candidateIds: string[];

      // If filtering by project or tags, use those indexes
      if (options?.projectId) {
        candidateIds = await this.client.sMembers(
          `${this.keyPrefix}project:${options.projectId}`
        );
      } else if (options?.tags?.length) {
        // Intersection of all tag sets
        const tagKeys = options.tags.map(tag => `${this.keyPrefix}tags:${tag}`);
        candidateIds = await this.client.sInter(tagKeys);
      } else {
        // Get top entries by relevance
        candidateIds = await this.client.zRange(
          `${this.keyPrefix}index:relevance`,
          -limit * 3,
          -1,
          { REV: true }
        );
      }

      // Fetch and filter entries
      for (const id of candidateIds) {
        const data = await this.client.get(`${this.keyPrefix}${id}`);
        if (data) {
          const entry = JSON.parse(data) as MemoryEntry;
          
          // Simple text matching
          const queryLower = query.toLowerCase();
          const contentLower = entry.content.toLowerCase();
          
          if (contentLower.includes(queryLower) || queryLower.length < 3) {
            // Apply tag filter if not already applied
            if (options?.tags?.length && !options.projectId) {
              const hasAllTags = options.tags.every(tag => 
                entry.metadata.tags.includes(tag)
              );
              if (!hasAllTags) continue;
            }

            results.push(entry);
            if (results.length >= limit) break;
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Search failed');
    }

    // Sort by relevance
    results.sort((a, b) => b.metadata.relevance - a.metadata.relevance);
    return results.slice(0, limit);
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
      await this.client.set(`${this.keyPrefix}${id}`, JSON.stringify(entry));

      // Update relevance score based on access
      const newRelevance = Math.min(1, entry.metadata.relevance + 0.01);
      entry.metadata.relevance = newRelevance;
      await this.client.zAdd(`${this.keyPrefix}index:relevance`, {
        score: newRelevance,
        value: id,
      });

      return entry;
    }

    return null;
  }

  /**
   * Delete an entry
   */
  async delete(id: string): Promise<void> {
    if (!this.client) return;

    // Get entry to clean up indexes
    const data = await this.client.get(`${this.keyPrefix}${id}`);
    if (data) {
      const entry = JSON.parse(data) as MemoryEntry;
      
      // Remove from tag indexes
      for (const tag of entry.metadata.tags) {
        await this.client.sRem(`${this.keyPrefix}tags:${tag}`, id);
      }

      // Remove from project index
      if (entry.metadata.projectId) {
        await this.client.sRem(
          `${this.keyPrefix}project:${entry.metadata.projectId}`,
          id
        );
      }
    }

    await this.client.del(`${this.keyPrefix}${id}`);
    await this.client.zRem(`${this.keyPrefix}index:relevance`, id);
  }

  /**
   * Get the count of entries
   */
  async count(): Promise<number> {
    if (!this.client) {
      return 0;
    }
    return this.client.zCard(`${this.keyPrefix}index:relevance`);
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
