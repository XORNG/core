import type {
  SubAgentResult,
  XORNGResponse,
  ResponseMetadata,
} from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Aggregation strategy for combining sub-agent results
 */
export type AggregationStrategy = 
  | 'concatenate'    // Simply concatenate all results
  | 'best-score'     // Use the result with highest confidence
  | 'consensus'      // Look for consensus among results
  | 'weighted'       // Weight by confidence and relevance
  | 'custom';        // Custom aggregation function

/**
 * Aggregator - Combines results from multiple sub-agents into a unified response
 * 
 * Responsibilities:
 * - Collect results from multiple sub-agents
 * - Apply aggregation strategies
 * - Handle conflicts and inconsistencies
 * - Generate metadata about the aggregation process
 */
export class Aggregator {
  private logger: Logger;

  constructor(logLevel: string = 'info') {
    this.logger = createLogger(logLevel, 'aggregator');
  }

  /**
   * Aggregate results from multiple sub-agents
   */
  async aggregate(
    requestId: string,
    results: SubAgentResult[],
    strategy: AggregationStrategy = 'weighted'
  ): Promise<XORNGResponse> {
    this.logger.debug({
      requestId,
      resultCount: results.length,
      strategy,
    }, 'Aggregating results');

    if (results.length === 0) {
      return this.createEmptyResponse(requestId);
    }

    let content: string;
    switch (strategy) {
      case 'concatenate':
        content = this.concatenateResults(results);
        break;
      case 'best-score':
        content = this.selectBestResult(results);
        break;
      case 'consensus':
        content = this.findConsensus(results);
        break;
      case 'weighted':
      default:
        content = this.weightedAggregate(results);
        break;
    }

    const metadata = this.calculateMetadata(results);

    const response: XORNGResponse = {
      id: crypto.randomUUID(),
      requestId,
      content,
      subAgentResults: results,
      metadata,
      timestamp: new Date(),
    };

    this.logger.info({
      requestId,
      responseId: response.id,
      metadata,
    }, 'Aggregation complete');

    return response;
  }

  /**
   * Simply concatenate all results with separators
   */
  private concatenateResults(results: SubAgentResult[]): string {
    return results
      .map(r => `[${r.agentName}]\n${r.content}`)
      .join('\n\n---\n\n');
  }

  /**
   * Select the result with the highest confidence score
   */
  private selectBestResult(results: SubAgentResult[]): string {
    const sorted = [...results].sort((a, b) => b.confidence - a.confidence);
    const best = sorted[0];
    return best ? best.content : '';
  }

  /**
   * Find consensus among results (look for common themes/conclusions)
   */
  private findConsensus(results: SubAgentResult[]): string {
    // For now, use a simple approach: select results above average confidence
    const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
    const highConfidence = results.filter(r => r.confidence >= avgConfidence);
    
    if (highConfidence.length === 1) {
      const result = highConfidence[0];
      return result ? result.content : '';
    }

    // Combine high-confidence results
    return highConfidence
      .map(r => r.content)
      .join('\n\n');
  }

  /**
   * Weighted aggregation based on confidence and execution time
   */
  private weightedAggregate(results: SubAgentResult[]): string {
    // Calculate weights based on confidence and inverse of execution time
    const maxExecutionTime = Math.max(...results.map(r => r.executionTimeMs));
    
    const weighted = results.map(r => {
      const timeWeight = 1 - (r.executionTimeMs / (maxExecutionTime + 1));
      const weight = (r.confidence * 0.7) + (timeWeight * 0.3);
      return { result: r, weight };
    });

    // Sort by weight
    weighted.sort((a, b) => b.weight - a.weight);

    // Build response prioritizing higher-weighted results
    const sections: string[] = [];
    let totalWeight = 0;
    const targetWeight = 0.8; // Stop when we've covered 80% of total weight

    const totalAvailable = weighted.reduce((sum, w) => sum + w.weight, 0);

    for (const { result, weight } of weighted) {
      sections.push(result.content);
      totalWeight += weight;

      if (totalWeight / totalAvailable >= targetWeight) {
        break;
      }
    }

    if (sections.length === 1) {
      return sections[0] || '';
    }

    return sections.join('\n\n---\n\n');
  }

  /**
   * Calculate response metadata
   */
  private calculateMetadata(results: SubAgentResult[]): ResponseMetadata {
    return {
      totalTokensUsed: results.reduce((sum, r) => sum + r.tokensUsed, 0),
      totalExecutionTimeMs: Math.max(...results.map(r => r.executionTimeMs), 0),
      agentsInvoked: results.length,
      memoryRetrievals: 0, // Will be set by the core
      cached: false,
    };
  }

  /**
   * Create an empty response when no results are available
   */
  private createEmptyResponse(requestId: string): XORNGResponse {
    return {
      id: crypto.randomUUID(),
      requestId,
      content: 'No results available from sub-agents.',
      subAgentResults: [],
      metadata: {
        totalTokensUsed: 0,
        totalExecutionTimeMs: 0,
        agentsInvoked: 0,
        memoryRetrievals: 0,
        cached: false,
      },
      timestamp: new Date(),
    };
  }

  /**
   * Merge results from the same agent type
   */
  mergeByAgentType(results: SubAgentResult[]): Map<string, SubAgentResult[]> {
    const merged = new Map<string, SubAgentResult[]>();

    for (const result of results) {
      const existing = merged.get(result.agentType) || [];
      existing.push(result);
      merged.set(result.agentType, existing);
    }

    return merged;
  }

  /**
   * Detect conflicts between results
   */
  detectConflicts(results: SubAgentResult[]): Array<{
    agents: string[];
    topic: string;
    description: string;
  }> {
    const conflicts: Array<{
      agents: string[];
      topic: string;
      description: string;
    }> = [];

    // This is a simplified conflict detection
    // In a real implementation, this would use NLP or semantic analysis
    
    // For now, flag if validators have very different confidence levels
    const validators = results.filter(r => r.agentType === 'validator');
    if (validators.length > 1) {
      const maxConf = Math.max(...validators.map(r => r.confidence));
      const minConf = Math.min(...validators.map(r => r.confidence));
      
      if (maxConf - minConf > 0.3) {
        conflicts.push({
          agents: validators.map(r => r.agentName),
          topic: 'validation',
          description: `Significant confidence variance (${minConf.toFixed(2)} - ${maxConf.toFixed(2)}) among validators`,
        });
      }
    }

    return conflicts;
  }
}
