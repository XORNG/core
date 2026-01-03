import type {
  XORNGRequest,
  RoutingDecision,
  SubAgent,
  SubAgentType,
} from '../types/index.js';
import { SubAgentManager } from '../agents/SubAgentManager.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Intent classification for request routing
 */
interface IntentClassification {
  primaryIntent: string;
  secondaryIntents: string[];
  requiredCapabilities: string[];
  confidence: number;
}

/**
 * Distributor - Routes incoming requests to appropriate sub-agents
 * 
 * Responsibilities:
 * - Analyze incoming requests to determine intent
 * - Select the most appropriate sub-agents based on capabilities
 * - Manage request priority and queuing
 * - Handle parallel vs sequential execution decisions
 */
export class Distributor {
  private logger: Logger;
  private intentPatterns: Map<string, string[]> = new Map();

  constructor(
    private agentManager: SubAgentManager,
    logLevel: string = 'info'
  ) {
    this.logger = createLogger(logLevel, 'distributor');
    this.initializeIntentPatterns();
  }

  /**
   * Initialize intent classification patterns
   */
  private initializeIntentPatterns(): void {
    // Validator-related intents
    this.intentPatterns.set('code-review', [
      'review', 'code quality', 'check', 'lint', 'analyze code'
    ]);
    this.intentPatterns.set('security', [
      'security', 'vulnerability', 'audit', 'secure', 'exploit'
    ]);
    this.intentPatterns.set('standards', [
      'standard', 'convention', 'best practice', 'style guide'
    ]);

    // Knowledge-related intents
    this.intentPatterns.set('documentation', [
      'document', 'explain', 'describe', 'how does', 'what is'
    ]);
    this.intentPatterns.set('api-reference', [
      'api', 'endpoint', 'method', 'parameter', 'schema'
    ]);

    // Task-related intents
    this.intentPatterns.set('build', [
      'build', 'compile', 'bundle', 'package'
    ]);
    this.intentPatterns.set('test', [
      'test', 'spec', 'coverage', 'unit test', 'integration'
    ]);
    this.intentPatterns.set('refactor', [
      'refactor', 'improve', 'optimize', 'clean up'
    ]);
  }

  /**
   * Classify the intent of a request
   */
  private classifyIntent(request: XORNGRequest): IntentClassification {
    const promptLower = request.prompt.toLowerCase();
    const detectedIntents: Array<{ intent: string; score: number }> = [];

    for (const [intent, patterns] of this.intentPatterns) {
      let score = 0;
      for (const pattern of patterns) {
        if (promptLower.includes(pattern)) {
          score += 1;
        }
      }
      if (score > 0) {
        detectedIntents.push({ intent, score });
      }
    }

    // Sort by score
    detectedIntents.sort((a, b) => b.score - a.score);

    if (detectedIntents.length === 0) {
      return {
        primaryIntent: 'general',
        secondaryIntents: [],
        requiredCapabilities: [],
        confidence: 0.5,
      };
    }

    const maxScore = detectedIntents[0]?.score || 0;
    const totalScore = detectedIntents.reduce((sum, d) => sum + d.score, 0);

    return {
      primaryIntent: detectedIntents[0]?.intent || 'general',
      secondaryIntents: detectedIntents.slice(1).map(d => d.intent),
      requiredCapabilities: this.mapIntentToCapabilities(detectedIntents[0]?.intent || 'general'),
      confidence: maxScore / Math.max(totalScore, 1),
    };
  }

  /**
   * Map intent to required capabilities
   */
  private mapIntentToCapabilities(intent: string): string[] {
    const capabilityMap: Record<string, string[]> = {
      'code-review': ['code-analysis', 'linting'],
      'security': ['security-scan', 'vulnerability-detection'],
      'standards': ['style-check', 'best-practices'],
      'documentation': ['documentation-generation', 'explanation'],
      'api-reference': ['api-analysis', 'schema-parsing'],
      'build': ['build-automation', 'compilation'],
      'test': ['test-execution', 'coverage-analysis'],
      'refactor': ['code-transformation', 'optimization'],
      'general': [],
    };

    return capabilityMap[intent] || [];
  }

  /**
   * Map intent to sub-agent types
   */
  private mapIntentToAgentType(intent: string): SubAgentType {
    const typeMap: Record<string, SubAgentType> = {
      'code-review': 'validator',
      'security': 'validator',
      'standards': 'validator',
      'documentation': 'knowledge',
      'api-reference': 'knowledge',
      'build': 'task',
      'test': 'task',
      'refactor': 'task',
      'general': 'dynamic',
    };

    return typeMap[intent] || 'dynamic';
  }

  /**
   * Select agents based on intent and capabilities
   */
  private selectAgents(
    classification: IntentClassification,
    options?: { preferredAgents?: string[]; excludeAgents?: string[] }
  ): { primary: SubAgent[]; secondary: SubAgent[] } {
    const allAgents = this.agentManager.getAllAgents();
    const preferredSet = new Set(options?.preferredAgents || []);
    const excludeSet = new Set(options?.excludeAgents || []);

    // Filter out excluded agents
    const availableAgents = allAgents.filter(
      agent => !excludeSet.has(agent.id) && agent.status !== 'disconnected'
    );

    // Prioritize preferred agents
    const preferred = availableAgents.filter(agent => preferredSet.has(agent.id));
    const others = availableAgents.filter(agent => !preferredSet.has(agent.id));

    // Select primary agents based on intent
    const primaryType = this.mapIntentToAgentType(classification.primaryIntent);
    const primaryAgents = [...preferred, ...others].filter(
      agent => agent.type === primaryType
    );

    // If no matching type, select by capabilities
    if (primaryAgents.length === 0) {
      const byCapability = availableAgents.filter(agent =>
        classification.requiredCapabilities.some(cap =>
          agent.capabilities.includes(cap)
        )
      );
      return { primary: byCapability.slice(0, 2), secondary: [] };
    }

    // Select secondary agents for additional intents
    const secondaryTypes = classification.secondaryIntents.map(
      intent => this.mapIntentToAgentType(intent)
    );
    const secondaryAgents = availableAgents.filter(
      agent => secondaryTypes.includes(agent.type) && !primaryAgents.includes(agent)
    );

    return {
      primary: primaryAgents.slice(0, 2),
      secondary: secondaryAgents.slice(0, 2),
    };
  }

  /**
   * Estimate token usage for a request
   */
  private estimateTokens(request: XORNGRequest): number {
    // Rough estimation: 1 token ≈ 4 characters
    const promptTokens = Math.ceil(request.prompt.length / 4);
    const contextTokens = request.context
      ? Math.ceil(JSON.stringify(request.context).length / 4)
      : 0;
    
    // Add overhead for system prompts and formatting
    const overhead = 500;
    
    return promptTokens + contextTokens + overhead;
  }

  /**
   * Generate memory queries based on the request
   */
  private generateMemoryQueries(
    request: XORNGRequest,
    classification: IntentClassification
  ): string[] {
    const queries: string[] = [];

    // Add the primary prompt as a query
    queries.push(request.prompt);

    // Add capability-based queries
    for (const capability of classification.requiredCapabilities) {
      queries.push(`${capability} patterns`);
    }

    // Add project-specific queries if context is available
    if (request.context?.projectPath) {
      queries.push(`project:${request.context.projectPath} patterns`);
    }

    if (request.context?.currentFile) {
      queries.push(`file:${request.context.currentFile} context`);
    }

    return queries;
  }

  /**
   * Route a request to appropriate sub-agents
   */
  async route(request: XORNGRequest): Promise<RoutingDecision> {
    this.logger.debug({ requestId: request.id }, 'Routing request');

    // Classify the intent
    const classification = this.classifyIntent(request);
    this.logger.debug({
      requestId: request.id,
      classification,
    }, 'Intent classified');

    // Select agents
    const { primary, secondary } = this.selectAgents(
      classification,
      request.options
    );

    // Generate memory queries
    const memoryQueries = this.generateMemoryQueries(request, classification);

    // Estimate tokens
    const estimatedTokens = this.estimateTokens(request);

    const decision: RoutingDecision = {
      primaryAgents: primary.map(a => a.id),
      secondaryAgents: secondary.map(a => a.id),
      memoryQueries,
      estimatedTokens,
      reasoning: `Intent: ${classification.primaryIntent} (confidence: ${classification.confidence.toFixed(2)}). ` +
        `Selected ${primary.length} primary and ${secondary.length} secondary agents.`,
    };

    this.logger.info({
      requestId: request.id,
      decision,
    }, 'Routing decision made');

    return decision;
  }
}
