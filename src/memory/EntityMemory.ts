import { createClient, type RedisClientType } from 'redis';
import type { MemoryEntry } from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * EntityMemory - Project-specific knowledge storage
 * 
 * Stores knowledge about entities: APIs, codebases, team patterns,
 * relationships between components, etc.
 */
export class EntityMemory {
  private client: RedisClientType | null = null;
  private logger: Logger;
  private redisUrl: string;
  private keyPrefix: string = 'xorng:entity:';

  constructor(
    redisUrl: string = 'redis://localhost:6379',
    logLevel: string = 'info'
  ) {
    this.redisUrl = redisUrl;
    this.logger = createLogger(logLevel, 'entity-memory');
  }

  /**
   * Initialize connection to Redis
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing entity memory...');

    try {
      this.client = createClient({ url: this.redisUrl });
      
      this.client.on('error', (err) => {
        this.logger.error({ error: err }, 'Redis client error');
      });

      await this.client.connect();
      this.logger.info('Entity memory initialized');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to connect to Redis, using in-memory fallback');
      this.client = null;
    }
  }

  /**
   * Store an entity memory entry
   */
  async store(entry: MemoryEntry): Promise<void> {
    const key = `${this.keyPrefix}${entry.id}`;
    const value = JSON.stringify(entry);

    if (this.client) {
      await this.client.set(key, value);
      
      // Index by entity type
      if (entry.metadata.entityType) {
        await this.client.sAdd(
          `${this.keyPrefix}type:${entry.metadata.entityType}`,
          entry.id
        );
      }

      // Index by entity ID for quick lookup
      if (entry.metadata.entityId) {
        await this.client.hSet(
          `${this.keyPrefix}lookup`,
          entry.metadata.entityId,
          entry.id
        );
      }

      // Index by project
      if (entry.metadata.projectId) {
        await this.client.sAdd(
          `${this.keyPrefix}project:${entry.metadata.projectId}`,
          entry.id
        );
      }

      // Add to timestamp index
      await this.client.zAdd(`${this.keyPrefix}index`, {
        score: entry.timestamp.getTime(),
        value: entry.id,
      });
    }

    this.logger.debug({
      entryId: entry.id,
      entityType: entry.metadata.entityType,
      entityId: entry.metadata.entityId,
    }, 'Stored entity memory');
  }

  /**
   * Search for relevant entity memories
   */
  async search(
    query: string,
    limit: number = 10,
    options?: { projectId?: string; tags?: string[]; entityType?: string }
  ): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    if (!this.client) {
      return results;
    }

    try {
      let candidateIds: string[];

      // Filter by entity type if specified
      if (options?.entityType) {
        candidateIds = await this.client.sMembers(
          `${this.keyPrefix}type:${options.entityType}`
        );
      } else if (options?.projectId) {
        candidateIds = await this.client.sMembers(
          `${this.keyPrefix}project:${options.projectId}`
        );
      } else {
        // Get all recent entries
        candidateIds = await this.client.zRange(
          `${this.keyPrefix}index`,
          -limit * 3,
          -1
        );
      }

      // Fetch and filter entries
      for (const id of candidateIds) {
        const data = await this.client.get(`${this.keyPrefix}${id}`);
        if (data) {
          const entry = JSON.parse(data) as MemoryEntry;
          
          // Text matching
          const queryLower = query.toLowerCase();
          const contentLower = entry.content.toLowerCase();
          
          if (contentLower.includes(queryLower) || queryLower.length < 3) {
            // Apply additional filters
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
   * Get entity by its entity ID (not memory ID)
   */
  async getByEntityId(entityId: string): Promise<MemoryEntry | null> {
    if (!this.client) {
      return null;
    }

    const memoryId = await this.client.hGet(`${this.keyPrefix}lookup`, entityId);
    if (memoryId) {
      return this.get(memoryId);
    }

    return null;
  }

  /**
   * Get a specific entry by memory ID
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

      return entry;
    }

    return null;
  }

  /**
   * Get all entities of a specific type
   */
  async getByType(entityType: string): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    if (!this.client) {
      return results;
    }

    const ids = await this.client.sMembers(`${this.keyPrefix}type:${entityType}`);
    
    for (const id of ids) {
      const entry = await this.get(id);
      if (entry) {
        results.push(entry);
      }
    }

    return results;
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
      
      // Remove from type index
      if (entry.metadata.entityType) {
        await this.client.sRem(
          `${this.keyPrefix}type:${entry.metadata.entityType}`,
          id
        );
      }

      // Remove from lookup
      if (entry.metadata.entityId) {
        await this.client.hDel(`${this.keyPrefix}lookup`, entry.metadata.entityId);
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
    await this.client.zRem(`${this.keyPrefix}index`, id);
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
