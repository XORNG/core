import type {
  XORNGRequest,
  XORNGResponse,
  SubAgentResult,
  RoutingDecision,
} from '../types/index.js';
import { loadConfig, type XORNGConfig } from '../config/index.js';
import { SubAgentManager, type SubAgentConfig } from '../agents/SubAgentManager.js';
import { Distributor } from './Distributor.js';
import { Aggregator, type AggregationStrategy } from './Aggregator.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { TokenTracker } from '../telemetry/TokenTracker.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * LLM Client interface for making language model requests
 * In IPC mode, this is provided by the extension via proxy
 */
export interface LLMClient {
  sendRequest(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { model?: string; maxTokens?: number }
  ): Promise<string>;
  
  sendStreamingRequest?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onChunk: (content: string) => void,
    options?: { model?: string; maxTokens?: number }
  ): Promise<string>;
}

/**
 * XORNGCore - Central Orchestration Engine
 * 
 * The main entry point for the XORNG system that coordinates:
 * - Sub-agent management and communication
 * - Request routing and distribution
 * - Response aggregation
 * - Memory system integration
 * - Token tracking and telemetry
 */
export class XORNGCore {
  private config: XORNGConfig;
  private logger: Logger;
  private agentManager: SubAgentManager;
  private distributor: Distributor;
  private aggregator: Aggregator;
  private memoryManager: MemoryManager;
  private tokenTracker: TokenTracker;
  private isInitialized: boolean = false;

  constructor(config?: Partial<XORNGConfig>) {
    this.config = { ...loadConfig(), ...config };
    this.logger = createLogger(this.config.logging.level, 'xorng-core');
    
    // Initialize components
    this.agentManager = new SubAgentManager(
      this.config.subAgents.maxConcurrent,
      this.config.logging.level
    );
    this.distributor = new Distributor(this.agentManager, this.config.logging.level);
    this.aggregator = new Aggregator(this.config.logging.level);
    this.memoryManager = new MemoryManager(
      this.config.redis.url,
      this.config.logging.level
    );
    this.tokenTracker = new TokenTracker(this.config.logging.level);
  }

  /**
   * Initialize the XORNG core system
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('XORNG Core is already initialized');
      return;
    }

    this.logger.info('Initializing XORNG Core...');

    try {
      // Initialize memory system
      await this.memoryManager.initialize();
      
      this.isInitialized = true;
      this.logger.info('XORNG Core initialized successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize XORNG Core');
      throw error;
    }
  }

  /**
   * Register a sub-agent with the system
   */
  async registerSubAgent(config: SubAgentConfig): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('XORNG Core is not initialized');
    }

    await this.agentManager.registerAgent(config);
  }

  /**
   * Process a request through the XORNG system
   * @param request The request to process
   * @param _llmClient Optional LLM client for making language model requests (required in IPC mode)
   * @param options Processing options
   */
  async process(
    request: XORNGRequest,
    _llmClient?: LLMClient,
    options?: {
      aggregationStrategy?: AggregationStrategy;
      includeMemory?: boolean;
    }
  ): Promise<XORNGResponse> {
    if (!this.isInitialized) {
      throw new Error('XORNG Core is not initialized');
    }

    const startTime = Date.now();
    this.logger.info({ requestId: request.id }, 'Processing request');

    try {
      // Track input tokens
      if (this.config.tokenTracking.enabled) {
        // Use model from options if available, otherwise default
        const model = typeof request.options?.model === 'string' ? request.options.model : 'gpt-4';
        this.tokenTracker.trackPrompt(request.id, request.prompt, model);
      }

      // Step 1: Route the request
      const routingDecision = await this.distributor.route(request);
      this.logger.debug({ requestId: request.id, routingDecision }, 'Routing complete');

      // Step 2: Retrieve relevant memory (if enabled)
      let memoryContext: string[] = [];
      if (options?.includeMemory !== false) {
        memoryContext = await this.retrieveMemory(routingDecision.memoryQueries);
      }

      // Step 3: Execute on sub-agents
      const results = await this.executeOnAgents(
        request,
        routingDecision,
        memoryContext
      );

      // Step 4: Aggregate results
      const response = await this.aggregator.aggregate(
        request.id,
        results,
        options?.aggregationStrategy
      );

      // Step 5: Update memory with successful response
      await this.updateMemory(request, response);

      // Track completion
      const executionTime = Date.now() - startTime;
      response.metadata.totalExecutionTimeMs = executionTime;

      if (this.config.tokenTracking.enabled) {
        this.tokenTracker.trackCompletion(request.id, response.content);
      }

      this.logger.info({
        requestId: request.id,
        responseId: response.id,
        executionTimeMs: executionTime,
        agentsInvoked: response.metadata.agentsInvoked,
      }, 'Request processed successfully');

      return response;
    } catch (error) {
      this.logger.error({ requestId: request.id, error }, 'Failed to process request');
      throw error;
    }
  }

  /**
   * Retrieve relevant context from memory
   */
  private async retrieveMemory(queries: string[]): Promise<string[]> {
    const results: string[] = [];

    for (const query of queries.slice(0, 5)) { // Limit to 5 queries
      try {
        const memories = await this.memoryManager.search(query, 3);
        results.push(...memories.map(m => m.content));
      } catch (error) {
        this.logger.warn({ query, error }, 'Failed to retrieve memory');
      }
    }

    return results;
  }

  /**
   * Execute the request on selected sub-agents
   */
  private async executeOnAgents(
    request: XORNGRequest,
    routing: RoutingDecision,
    memoryContext: string[]
  ): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    const allAgentIds = [...routing.primaryAgents, ...routing.secondaryAgents];

    if (allAgentIds.length === 0) {
      this.logger.warn({ requestId: request.id }, 'No agents available for request');
      return results;
    }

    // Prepare enhanced prompt with memory context
    const enhancedPrompt = memoryContext.length > 0
      ? `Context:\n${memoryContext.join('\n')}\n\n${request.prompt}`
      : request.prompt;

    // Execute on agents (can be parallel based on options)
    const executeOnAgent = async (agentId: string): Promise<SubAgentResult | null> => {
      const connection = this.agentManager.getConnection(agentId);
      if (!connection) {
        this.logger.warn({ agentId }, 'Agent connection not found');
        return null;
      }

      const agentStartTime = Date.now();

      try {
        // Call the agent's main processing tool
        const result = await connection.callTool('process', {
          prompt: enhancedPrompt,
          context: request.context,
        });

        const executionTime = Date.now() - agentStartTime;

        return {
          agentId,
          agentName: connection.agent.name,
          agentType: connection.agent.type,
          content: typeof result.content === 'string' 
            ? result.content 
            : JSON.stringify(result.content),
          confidence: 0.8, // TODO: Get from actual result
          tokensUsed: 0, // TODO: Track actual tokens
          executionTimeMs: executionTime,
          toolsUsed: ['process'],
        };
      } catch (error) {
        this.logger.error({ agentId, error }, 'Agent execution failed');
        return null;
      }
    };

    // Execute on all agents
    const promises = allAgentIds.map(executeOnAgent);
    const agentResults = await Promise.all(promises);

    // Filter out null results
    for (const result of agentResults) {
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Update memory with request/response pair
   */
  private async updateMemory(
    request: XORNGRequest,
    response: XORNGResponse
  ): Promise<void> {
    try {
      // Store successful interaction in short-term memory
      await this.memoryManager.store({
        type: 'short-term',
        content: `Q: ${request.prompt}\nA: ${response.content.slice(0, 500)}`,
        metadata: {
          source: 'interaction',
          projectId: request.context?.projectPath,
          tags: ['interaction', 'successful'],
        },
      });

      // If this was a high-confidence response, consider for long-term memory
      const avgConfidence = response.subAgentResults.reduce(
        (sum, r) => sum + r.confidence,
        0
      ) / Math.max(response.subAgentResults.length, 1);

      if (avgConfidence > 0.85) {
        await this.memoryManager.store({
          type: 'long-term',
          content: `Pattern: ${request.prompt}\nSolution: ${response.content}`,
          metadata: {
            source: 'learned-pattern',
            relevance: avgConfidence,
            tags: ['pattern', 'high-confidence'],
          },
        });
      }
    } catch (error) {
      this.logger.warn({ error }, 'Failed to update memory');
    }
  }

  /**
   * Get token usage statistics
   */
  getTokenUsage(): {
    promptTokens: number;
    completionTokens: number;
    estimatedCost: number;
    dailyLimit?: number;
  } {
    const stats = this.tokenTracker.getStats();
    return {
      promptTokens: stats.totalPromptTokens,
      completionTokens: stats.totalCompletionTokens,
      estimatedCost: stats.estimatedCost,
      dailyLimit: this.config.tokenTracking?.dailyLimit || 0,
    };
  }

  /**
   * Search memory for relevant content
   */
  async searchMemory(query: string, limit = 10): Promise<Array<{
    id: string;
    content: string;
    relevance?: number;
    timestamp: Date;
  }>> {
    return this.memoryManager.search(query, limit);
  }

  /**
   * Clear memory by type
   */
  async clearMemory(type?: 'short-term' | 'long-term' | 'all'): Promise<void> {
    // For now, only support clearing short-term memory
    if (type === 'short-term' || type === 'all' || !type) {
      await this.memoryManager.clearShortTerm();
    }
    // Long-term memory clearing would need to be implemented in MemoryManager
  }

  /**
   * Get registered sub-agents
   */
  getSubAgents() {
    return this.agentManager.getAllAgents();
  }

  /**
   * Shutdown the XORNG core
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down XORNG Core...');

    await this.agentManager.disconnectAll();
    await this.memoryManager.close();

    this.isInitialized = false;
    this.logger.info('XORNG Core shutdown complete');
  }
}
