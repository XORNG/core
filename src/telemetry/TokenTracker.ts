import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Token usage record for a single request
 */
interface TokenRecord {
  requestId: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  timestamp: Date;
}

/**
 * TokenTracker - Tracks token usage across requests
 * 
 * Uses tiktoken for accurate token counting.
 * Provides hooks for real-time tracking and cost estimation.
 */
export class TokenTracker {
  private logger: Logger;
  private records: Map<string, TokenRecord> = new Map();
  private totalPromptTokens: number = 0;
  private totalCompletionTokens: number = 0;
  
  // Cost per 1K tokens (USD) - these are approximate, update as needed
  private costPer1kPromptTokens: number = 0.003;
  private costPer1kCompletionTokens: number = 0.015;

  constructor(logLevel: string = 'info') {
    this.logger = createLogger(logLevel, 'token-tracker');
  }

  /**
   * Estimate token count for a string
   * Uses a simple approximation: ~4 characters per token
   * For production, integrate with tiktoken for accurate counting
   */
  private estimateTokens(text: string): number {
    // Simple estimation: ~4 characters per token for English text
    // This should be replaced with actual tiktoken integration
    return Math.ceil(text.length / 4);
  }

  /**
   * Track tokens for a prompt
   */
  trackPrompt(requestId: string, prompt: string, model: string = 'gpt-4'): void {
    const tokens = this.estimateTokens(prompt);
    
    const record: TokenRecord = {
      requestId,
      promptTokens: tokens,
      completionTokens: 0,
      model,
      timestamp: new Date(),
    };

    this.records.set(requestId, record);
    this.totalPromptTokens += tokens;

    this.logger.debug({
      requestId,
      promptTokens: tokens,
    }, 'Tracked prompt tokens');
  }

  /**
   * Track tokens for a completion
   */
  trackCompletion(requestId: string, completion: string): void {
    const tokens = this.estimateTokens(completion);
    const record = this.records.get(requestId);

    if (record) {
      record.completionTokens = tokens;
      this.totalCompletionTokens += tokens;
    } else {
      // Create a new record if prompt wasn't tracked
      this.records.set(requestId, {
        requestId,
        promptTokens: 0,
        completionTokens: tokens,
        model: 'unknown',
        timestamp: new Date(),
      });
      this.totalCompletionTokens += tokens;
    }

    this.logger.debug({
      requestId,
      completionTokens: tokens,
    }, 'Tracked completion tokens');
  }

  /**
   * Track actual token counts (when available from API response)
   */
  trackActual(
    requestId: string,
    promptTokens: number,
    completionTokens: number,
    model: string
  ): void {
    const existing = this.records.get(requestId);
    
    // Adjust totals if we had estimates
    if (existing) {
      this.totalPromptTokens -= existing.promptTokens;
      this.totalCompletionTokens -= existing.completionTokens;
    }

    this.records.set(requestId, {
      requestId,
      promptTokens,
      completionTokens,
      model,
      timestamp: new Date(),
    });

    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;

    this.logger.debug({
      requestId,
      promptTokens,
      completionTokens,
      model,
    }, 'Tracked actual tokens');
  }

  /**
   * Get token usage for a specific request
   */
  getUsage(requestId: string): TokenRecord | undefined {
    return this.records.get(requestId);
  }

  /**
   * Get aggregate statistics
   */
  getStats(): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedCost: number;
  } {
    const promptCost = (this.totalPromptTokens / 1000) * this.costPer1kPromptTokens;
    const completionCost = (this.totalCompletionTokens / 1000) * this.costPer1kCompletionTokens;

    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      estimatedCost: promptCost + completionCost,
    };
  }

  /**
   * Get recent records
   */
  getRecentRecords(limit: number = 100): TokenRecord[] {
    const allRecords = Array.from(this.records.values());
    return allRecords
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Set cost rates per 1K tokens
   */
  setCostRates(promptRate: number, completionRate: number): void {
    this.costPer1kPromptTokens = promptRate;
    this.costPer1kCompletionTokens = completionRate;
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.records.clear();
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.logger.info('Token tracking reset');
  }

  /**
   * Export records for analysis
   */
  export(): TokenRecord[] {
    return Array.from(this.records.values());
  }
}
