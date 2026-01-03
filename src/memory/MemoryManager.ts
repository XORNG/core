import type { MemoryEntry, MemoryMetadata } from '../types/index.js';
import { ShortTermMemory } from './ShortTermMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { EntityMemory } from './EntityMemory.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Input for storing a new memory
 */
export interface MemoryInput {
  type: 'short-term' | 'long-term' | 'entity';
  content: string;
  metadata?: Partial<MemoryMetadata>;
}

/**
 * MemoryManager - Unified interface for the XORNG memory system
 * 
 * Manages three types of memory:
 * - Short-Term Memory: Current session context, recent interactions (RAG-based)
 * - Long-Term Memory: Successful patterns, learned optimizations, past mistakes
 * - Entity Memory: Project-specific knowledge - APIs, codebases, team patterns
 */
export class MemoryManager {
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private entity: EntityMemory;
  private logger: Logger;
  private isInitialized: boolean = false;

  constructor(
    redisUrl: string = 'redis://localhost:6379',
    logLevel: string = 'info'
  ) {
    this.logger = createLogger(logLevel, 'memory-manager');
    this.shortTerm = new ShortTermMemory(redisUrl, logLevel);
    this.longTerm = new LongTermMemory(redisUrl, logLevel);
    this.entity = new EntityMemory(redisUrl, logLevel);
  }

  /**
   * Initialize all memory stores
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.logger.info('Initializing memory system...');

    try {
      await Promise.all([
        this.shortTerm.initialize(),
        this.longTerm.initialize(),
        this.entity.initialize(),
      ]);

      this.isInitialized = true;
      this.logger.info('Memory system initialized');
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize memory system');
      throw error;
    }
  }

  /**
   * Store a new memory entry
   */
  async store(input: MemoryInput): Promise<MemoryEntry> {
    if (!this.isInitialized) {
      throw new Error('Memory system is not initialized');
    }

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      type: input.type,
      content: input.content,
      metadata: {
        source: input.metadata?.source || 'unknown',
        relevance: input.metadata?.relevance || 0.5,
        accessCount: 0,
        lastAccessed: new Date(),
        tags: input.metadata?.tags || [],
        projectId: input.metadata?.projectId,
        entityType: input.metadata?.entityType,
        entityId: input.metadata?.entityId,
      },
      timestamp: new Date(),
    };

    switch (input.type) {
      case 'short-term':
        await this.shortTerm.store(entry);
        break;
      case 'long-term':
        await this.longTerm.store(entry);
        break;
      case 'entity':
        await this.entity.store(entry);
        break;
    }

    this.logger.debug({ entryId: entry.id, type: entry.type }, 'Memory stored');
    return entry;
  }

  /**
   * Search for relevant memories across all stores
   */
  async search(
    query: string,
    limit: number = 10,
    options?: {
      types?: Array<'short-term' | 'long-term' | 'entity'>;
      projectId?: string;
      tags?: string[];
    }
  ): Promise<MemoryEntry[]> {
    if (!this.isInitialized) {
      throw new Error('Memory system is not initialized');
    }

    const types = options?.types || ['short-term', 'long-term', 'entity'];
    const results: MemoryEntry[] = [];

    const searchPromises: Promise<MemoryEntry[]>[] = [];

    if (types.includes('short-term')) {
      searchPromises.push(this.shortTerm.search(query, limit, options));
    }
    if (types.includes('long-term')) {
      searchPromises.push(this.longTerm.search(query, limit, options));
    }
    if (types.includes('entity')) {
      searchPromises.push(this.entity.search(query, limit, options));
    }

    const allResults = await Promise.all(searchPromises);
    
    for (const entries of allResults) {
      results.push(...entries);
    }

    // Sort by relevance and return top results
    results.sort((a, b) => b.metadata.relevance - a.metadata.relevance);
    return results.slice(0, limit);
  }

  /**
   * Get a specific memory entry by ID
   */
  async get(id: string, type: 'short-term' | 'long-term' | 'entity'): Promise<MemoryEntry | null> {
    if (!this.isInitialized) {
      throw new Error('Memory system is not initialized');
    }

    switch (type) {
      case 'short-term':
        return this.shortTerm.get(id);
      case 'long-term':
        return this.longTerm.get(id);
      case 'entity':
        return this.entity.get(id);
    }
  }

  /**
   * Delete a memory entry
   */
  async delete(id: string, type: 'short-term' | 'long-term' | 'entity'): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Memory system is not initialized');
    }

    switch (type) {
      case 'short-term':
        await this.shortTerm.delete(id);
        break;
      case 'long-term':
        await this.longTerm.delete(id);
        break;
      case 'entity':
        await this.entity.delete(id);
        break;
    }

    this.logger.debug({ id, type }, 'Memory deleted');
  }

  /**
   * Clear short-term memory (useful for new sessions)
   */
  async clearShortTerm(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Memory system is not initialized');
    }

    await this.shortTerm.clear();
    this.logger.info('Short-term memory cleared');
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    shortTermCount: number;
    longTermCount: number;
    entityCount: number;
  }> {
    const [shortTermCount, longTermCount, entityCount] = await Promise.all([
      this.shortTerm.count(),
      this.longTerm.count(),
      this.entity.count(),
    ]);

    return { shortTermCount, longTermCount, entityCount };
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    this.logger.info('Closing memory system...');

    await Promise.all([
      this.shortTerm.close(),
      this.longTerm.close(),
      this.entity.close(),
    ]);

    this.isInitialized = false;
    this.logger.info('Memory system closed');
  }
}
