import { EventEmitter } from 'events';
import type { MemoryManager } from '../memory/MemoryManager.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Pipeline fix pattern - learned from successful auto-fixes
 */
export interface FixPattern {
  id: string;
  failureType: 'lint' | 'typecheck' | 'test' | 'build' | 'security' | 'format' | 'other';
  errorPattern: string;
  appliedFix: {
    file: string;
    description: string;
    changeType: 'modify' | 'create' | 'delete';
  }[];
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsed: Date;
  createdAt: Date;
}

/**
 * Self-improvement metrics tracked by the learning service
 */
export interface SelfImprovementMetrics {
  /** Fix success rate by failure type */
  fixSuccessRateByType: Record<string, { success: number; failure: number; rate: number }>;
  /** Average attempts needed to fix issues */
  averageAttemptsToFix: number;
  /** How quickly success rate improves over time */
  learningVelocity: number;
  /** How often past patterns help with fixes */
  patternHitRate: number;
  /** Total patterns learned */
  totalPatternsLearned: number;
  /** Knowledge agent utilization */
  knowledgeAgentHits: number;
  /** Validator pre-check results */
  validatorPreCheckResults: { passed: number; failed: number };
}

/**
 * Fix attempt record for tracking
 */
export interface FixAttemptRecord {
  id: string;
  repo: string;
  prNumber: number;
  failureType: string;
  errorPattern: string;
  attemptNumber: number;
  successful: boolean;
  patternUsed?: string;
  knowledgeUsed?: boolean;
  validatorPassed?: boolean;
  appliedFixes?: Array<{ file: string; description: string }>;
  timestamp: Date;
  error?: string;
}

/**
 * Configuration for LearningService
 */
export interface LearningServiceConfig {
  memoryManager?: MemoryManager;
  logLevel?: string;
  /** Minimum confidence for pattern to be suggested */
  minPatternConfidence?: number;
  /** Maximum patterns to store per failure type */
  maxPatternsPerType?: number;
}

/**
 * LearningService - Central service for self-improvement learning
 * 
 * Shared between pipeline automation and VS Code extension to:
 * - Track successful and failed fix patterns
 * - Store learned patterns in long-term memory
 * - Provide pattern suggestions for similar failures
 * - Calculate self-improvement metrics
 * 
 * This service implements the "learn from failures" principle from
 * the XORNG self-improvement guidelines.
 */
export class LearningService extends EventEmitter {
  private logger: Logger;
  private memoryManager?: MemoryManager;
  private config: Required<Omit<LearningServiceConfig, 'memoryManager' | 'logLevel'>>;

  // In-memory stores (backed by Redis via MemoryManager when available)
  private fixPatterns: Map<string, FixPattern> = new Map();
  private fixAttempts: FixAttemptRecord[] = [];
  private metrics: SelfImprovementMetrics = {
    fixSuccessRateByType: {},
    averageAttemptsToFix: 0,
    learningVelocity: 0,
    patternHitRate: 0,
    totalPatternsLearned: 0,
    knowledgeAgentHits: 0,
    validatorPreCheckResults: { passed: 0, failed: 0 },
  };

  constructor(config: LearningServiceConfig = {}) {
    super();
    this.logger = createLogger(config.logLevel || 'info', 'learning-service');
    this.memoryManager = config.memoryManager;
    this.config = {
      minPatternConfidence: config.minPatternConfidence ?? 0.7,
      maxPatternsPerType: config.maxPatternsPerType ?? 100,
    };

    this.logger.info('Learning service initialized');
  }

  /**
   * Set or update the memory manager (for deferred initialization)
   */
  setMemoryManager(memoryManager: MemoryManager): void {
    this.memoryManager = memoryManager;
    this.logger.info('Memory manager connected to learning service');
  }

  /**
   * Record a fix attempt (successful or failed)
   */
  async recordFixAttempt(attempt: Omit<FixAttemptRecord, 'id' | 'timestamp'>): Promise<void> {
    const record: FixAttemptRecord = {
      ...attempt,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    this.fixAttempts.push(record);

    // Keep last 10000 attempts in memory
    if (this.fixAttempts.length > 10000) {
      this.fixAttempts = this.fixAttempts.slice(-10000);
    }

    // Update metrics
    this.updateMetrics(record);

    // If successful, learn from this fix
    if (record.successful && record.appliedFixes?.length) {
      await this.learnFromSuccess(record);
    }

    // Emit event for external listeners
    this.emit('fix-attempt', record);

    this.logger.info({
      repo: record.repo,
      prNumber: record.prNumber,
      failureType: record.failureType,
      successful: record.successful,
      attemptNumber: record.attemptNumber,
    }, 'Recorded fix attempt');
  }

  /**
   * Learn from a successful fix by storing the pattern
   */
  private async learnFromSuccess(record: FixAttemptRecord): Promise<void> {
    const patternId = this.generatePatternId(record.failureType, record.errorPattern);
    
    const existingPattern = this.fixPatterns.get(patternId);

    if (existingPattern) {
      // Update existing pattern
      existingPattern.successCount++;
      existingPattern.confidence = this.calculateConfidence(existingPattern);
      existingPattern.lastUsed = new Date();
      this.fixPatterns.set(patternId, existingPattern);
    } else {
      // Create new pattern
      const newPattern: FixPattern = {
        id: patternId,
        failureType: record.failureType as FixPattern['failureType'],
        errorPattern: record.errorPattern,
        appliedFix: record.appliedFixes?.map(f => ({
          file: f.file,
          description: f.description,
          changeType: 'modify' as const,
        })) || [],
        confidence: 0.7, // Initial confidence
        successCount: 1,
        failureCount: 0,
        lastUsed: new Date(),
        createdAt: new Date(),
      };

      this.fixPatterns.set(patternId, newPattern);
      this.metrics.totalPatternsLearned++;
    }

    // Store in long-term memory if available
    if (this.memoryManager) {
      try {
        await this.memoryManager.store({
          type: 'long-term',
          content: JSON.stringify({
            type: 'pipeline-fix-pattern',
            failureType: record.failureType,
            errorPattern: record.errorPattern,
            appliedFixes: record.appliedFixes,
            repo: record.repo,
            timestamp: record.timestamp.toISOString(),
          }),
          metadata: {
            source: 'pipeline-fix-success',
            relevance: 0.9,
            tags: ['pipeline', record.failureType, 'learned-fix', 'pattern'],
          },
        });

        this.logger.debug({ patternId }, 'Stored pattern in long-term memory');
      } catch (error) {
        this.logger.warn({ error, patternId }, 'Failed to store pattern in memory');
      }
    }

    this.emit('pattern-learned', this.fixPatterns.get(patternId));
  }

  /**
   * Record when a pattern was used but failed
   */
  async recordPatternFailure(patternId: string): Promise<void> {
    const pattern = this.fixPatterns.get(patternId);
    if (pattern) {
      pattern.failureCount++;
      pattern.confidence = this.calculateConfidence(pattern);
      this.fixPatterns.set(patternId, pattern);

      this.logger.debug({ patternId, newConfidence: pattern.confidence }, 'Pattern confidence decreased');
    }
  }

  /**
   * Find similar patterns that might help fix a failure
   */
  async findSimilarPatterns(
    failureType: string,
    errorPattern: string,
    limit: number = 5
  ): Promise<FixPattern[]> {
    const candidates: Array<{ pattern: FixPattern; score: number }> = [];

    for (const pattern of this.fixPatterns.values()) {
      if (pattern.failureType !== failureType) continue;
      if (pattern.confidence < this.config.minPatternConfidence) continue;

      // Calculate similarity score
      const score = this.calculateSimilarity(errorPattern, pattern.errorPattern);
      if (score > 0.3) {
        candidates.push({ pattern, score: score * pattern.confidence });
      }
    }

    // Also search long-term memory for additional patterns
    if (this.memoryManager) {
      try {
        const memoryResults = await this.memoryManager.search(
          `${failureType} ${errorPattern}`,
          limit,
          { tags: ['pipeline', 'learned-fix'], types: ['long-term'] }
        );

        for (const entry of memoryResults) {
          try {
            const data = JSON.parse(entry.content);
            if (data.type === 'pipeline-fix-pattern' && data.failureType === failureType) {
              // Check if we already have this pattern
              const patternId = this.generatePatternId(data.failureType, data.errorPattern);
              if (!this.fixPatterns.has(patternId)) {
                candidates.push({
                  pattern: {
                    id: patternId,
                    failureType: data.failureType,
                    errorPattern: data.errorPattern,
                    appliedFix: data.appliedFixes || [],
                    confidence: entry.metadata.relevance,
                    successCount: 1,
                    failureCount: 0,
                    lastUsed: new Date(data.timestamp),
                    createdAt: new Date(data.timestamp),
                  },
                  score: entry.metadata.relevance,
                });
                this.metrics.patternHitRate++;
              }
            }
          } catch {
            // Skip invalid entries
          }
        }
      } catch (error) {
        this.logger.warn({ error }, 'Failed to search memory for patterns');
      }
    }

    // Sort by score and return top results
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(c => c.pattern);
  }

  /**
   * Build enhanced prompt with learned patterns
   */
  async buildEnhancedPrompt(
    failureType: string,
    errorPattern: string,
    basePrompt: string
  ): Promise<string> {
    const patterns = await this.findSimilarPatterns(failureType, errorPattern, 3);

    if (patterns.length === 0) {
      return basePrompt;
    }

    const patternContext = patterns.map((p, i) => 
      `${i + 1}. Previous fix for similar "${p.failureType}" error:\n` +
      `   Error: ${p.errorPattern.slice(0, 200)}\n` +
      `   Fix: ${p.appliedFix.map(f => `${f.file}: ${f.description}`).join(', ')}\n` +
      `   Confidence: ${Math.round(p.confidence * 100)}%`
    ).join('\n\n');

    return `Previous successful fixes for similar issues:\n${patternContext}\n\n---\n\n${basePrompt}`;
  }

  /**
   * Record knowledge agent usage
   */
  recordKnowledgeAgentHit(): void {
    this.metrics.knowledgeAgentHits++;
    this.emit('knowledge-agent-hit');
  }

  /**
   * Record validator pre-check result
   */
  recordValidatorResult(passed: boolean): void {
    if (passed) {
      this.metrics.validatorPreCheckResults.passed++;
    } else {
      this.metrics.validatorPreCheckResults.failed++;
    }
    this.emit('validator-result', { passed });
  }

  /**
   * Get current metrics
   */
  getMetrics(): SelfImprovementMetrics {
    return { ...this.metrics };
  }

  /**
   * Get fix success rate for a specific failure type
   */
  getSuccessRateForType(failureType: string): number {
    const stats = this.metrics.fixSuccessRateByType[failureType];
    if (!stats) return 0;
    return stats.rate;
  }

  /**
   * Get all learned patterns
   */
  getPatterns(): FixPattern[] {
    return Array.from(this.fixPatterns.values());
  }

  /**
   * Get pattern by ID
   */
  getPattern(patternId: string): FixPattern | undefined {
    return this.fixPatterns.get(patternId);
  }

  /**
   * Export learning data for persistence
   */
  exportData(): {
    patterns: FixPattern[];
    recentAttempts: FixAttemptRecord[];
    metrics: SelfImprovementMetrics;
  } {
    return {
      patterns: Array.from(this.fixPatterns.values()),
      recentAttempts: this.fixAttempts.slice(-1000),
      metrics: this.metrics,
    };
  }

  /**
   * Import learning data from persistence
   */
  importData(data: {
    patterns?: FixPattern[];
    metrics?: Partial<SelfImprovementMetrics>;
  }): void {
    if (data.patterns) {
      for (const pattern of data.patterns) {
        this.fixPatterns.set(pattern.id, pattern);
      }
      this.metrics.totalPatternsLearned = this.fixPatterns.size;
    }

    if (data.metrics) {
      this.metrics = { ...this.metrics, ...data.metrics };
    }

    this.logger.info({
      patternsImported: data.patterns?.length || 0,
    }, 'Imported learning data');
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Generate a unique pattern ID from failure type and error
   */
  private generatePatternId(failureType: string, errorPattern: string): string {
    // Normalize the error pattern by removing line numbers and specific values
    const normalized = errorPattern
      .toLowerCase()
      .replace(/line \d+/g, 'line N')
      .replace(/:\d+:\d+/g, ':N:N')
      .replace(/\d+/g, 'N')
      .trim()
      .slice(0, 100);
    
    return `${failureType}:${this.hashString(normalized)}`;
  }

  /**
   * Simple string hash for pattern ID generation
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Calculate confidence based on success/failure ratio
   */
  private calculateConfidence(pattern: FixPattern): number {
    const total = pattern.successCount + pattern.failureCount;
    if (total === 0) return 0.5;
    
    // Bayesian-adjusted confidence with prior
    const priorSuccess = 1;
    const priorFailure = 1;
    return (pattern.successCount + priorSuccess) / (total + priorSuccess + priorFailure);
  }

  /**
   * Calculate similarity between two error patterns
   */
  private calculateSimilarity(pattern1: string, pattern2: string): number {
    // Normalize patterns
    const normalize = (s: string) => s.toLowerCase()
      .replace(/line \d+/g, 'line')
      .replace(/:\d+:\d+/g, ':')
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const n1 = normalize(pattern1);
    const n2 = normalize(pattern2);

    // Simple token overlap similarity
    const tokens1 = new Set(n1.split(' '));
    const tokens2 = new Set(n2.split(' '));
    
    let overlap = 0;
    for (const t of tokens1) {
      if (tokens2.has(t)) overlap++;
    }

    return overlap / Math.max(tokens1.size, tokens2.size);
  }

  /**
   * Update metrics based on a fix attempt
   */
  private updateMetrics(record: FixAttemptRecord): void {
    // Update type-specific success rate
    let typeStats = this.metrics.fixSuccessRateByType[record.failureType];
    if (!typeStats) {
      typeStats = {
        success: 0,
        failure: 0,
        rate: 0,
      };
      this.metrics.fixSuccessRateByType[record.failureType] = typeStats;
    }

    if (record.successful) {
      typeStats.success++;
    } else {
      typeStats.failure++;
    }
    typeStats.rate = typeStats.success / (typeStats.success + typeStats.failure);

    // Update average attempts to fix
    const successfulAttempts = this.fixAttempts.filter(a => a.successful);
    if (successfulAttempts.length > 0) {
      this.metrics.averageAttemptsToFix = 
        successfulAttempts.reduce((sum, a) => sum + a.attemptNumber, 0) / 
        successfulAttempts.length;
    }

    // Calculate learning velocity (improvement in success rate over time)
    this.calculateLearningVelocity();
  }

  /**
   * Calculate learning velocity - how fast success rate improves
   */
  private calculateLearningVelocity(): void {
    const recentAttempts = this.fixAttempts.slice(-100);
    if (recentAttempts.length < 20) {
      this.metrics.learningVelocity = 0;
      return;
    }

    const firstHalf = recentAttempts.slice(0, Math.floor(recentAttempts.length / 2));
    const secondHalf = recentAttempts.slice(Math.floor(recentAttempts.length / 2));

    const firstRate = firstHalf.filter(a => a.successful).length / firstHalf.length;
    const secondRate = secondHalf.filter(a => a.successful).length / secondHalf.length;

    this.metrics.learningVelocity = secondRate - firstRate;
  }
}
