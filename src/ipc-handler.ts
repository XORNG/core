/**
 * IPC Handler for XORNG Core
 * 
 * This module handles IPC communication when Core is spawned as a child process
 * by the VS Code extension. It replaces the HTTP server for local deployments.
 */

import { XORNGCore } from './core/XORNGCore.js';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';

// ============================================================================
// IPC Message Types (mirrored from extension)
// ============================================================================

interface IPCMessage {
  type: string;
  id: string;
  timestamp: number;
}

interface IPCRequest extends IPCMessage {
  payload: unknown;
}

interface IPCResponse extends IPCMessage {
  requestId: string;
  success: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================================
// LLM Client (requests LLM access from extension via IPC)
// ============================================================================

class IPCLLMClient {
  private pendingRequests = new Map<string, {
    resolve: (content: string) => void;
    reject: (error: Error) => void;
  }>();

  /**
   * Send LLM request to extension and wait for response
   */
  async sendRequest(
    messages: LLMMessage[],
    options?: { model?: string | any; maxTokens?: number }
  ): Promise<string> {
    const id = `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Send request to extension via IPC
      process.send?.({
        type: 'llm:request',
        id,
        timestamp: Date.now(),
        payload: { messages, options },
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('LLM request timed out'));
        }
      }, 60000);
    });
  }

  /**
   * Send streaming LLM request
   */
  async sendStreamingRequest(
    messages: LLMMessage[],
    onChunk: (content: string) => void,
    options?: { model?: string | any; maxTokens?: number }
  ): Promise<string> {
    const id = `llm_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Set up chunk handler
      const chunkHandler = (msg: IPCMessage) => {
        const msgWithRequestId = msg as IPCMessage & { requestId?: string; payload?: { content: string; done: boolean } };
        if (msg.type === 'llm:chunk' && msgWithRequestId.requestId === id && msgWithRequestId.payload) {
          onChunk(msgWithRequestId.payload.content);
        }
      };
      process.on('message', chunkHandler);

      // Send request to extension via IPC
      process.send?.({
        type: 'llm:stream',
        id,
        timestamp: Date.now(),
        payload: { messages, options },
      });

      // Timeout after 120 seconds for streaming
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          process.off('message', chunkHandler);
          reject(new Error('LLM streaming request timed out'));
        }
      }, 120000);
    });
  }

  /**
   * Handle LLM response from extension
   */
  handleResponse(response: IPCResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (pending) {
      this.pendingRequests.delete(response.requestId);
      if (response.success) {
        pending.resolve((response.payload as { content: string }).content);
      } else {
        pending.reject(new Error(response.error?.message || 'LLM request failed'));
      }
    }
  }
}

// ============================================================================
// IPC Handler
// ============================================================================

class IPCHandler {
  private core: XORNGCore;
  private llmClient: IPCLLMClient;
  private logger = createLogger('info', 'ipc-handler');

  constructor(core: XORNGCore, llmClient: IPCLLMClient) {
    this.core = core;
    this.llmClient = llmClient;
  }

  /**
   * Handle incoming IPC message
   */
  async handleMessage(msg: unknown): Promise<void> {
    if (!this.isIPCRequest(msg)) {
      this.logger.warn('Invalid IPC message received');
      return;
    }

    const request = msg as IPCRequest;

    try {
      switch (request.type) {
        case 'llm:response':
          this.llmClient.handleResponse(request as unknown as IPCResponse);
          break;

        case 'agents:list':
          await this.handleAgentsList(request);
          break;

        case 'process:request':
          await this.handleProcessRequest(request);
          break;

        case 'tokens:usage':
          await this.handleTokenUsage(request);
          break;

        case 'memory:search':
          await this.handleMemorySearch(request);
          break;

        case 'memory:clear':
          await this.handleMemoryClear(request);
          break;

        case 'core:health':
          await this.handleHealth(request);
          break;

        case 'core:shutdown':
          await this.handleShutdown(request);
          break;

        default:
          this.sendError(request.id, 'UNKNOWN_TYPE', `Unknown message type: ${request.type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error handling message ${request.type}: ${errorMessage}`);
      this.sendError(
        request.id,
        'INTERNAL_ERROR',
        errorMessage
      );
    }
  }

  /**
   * Handle agents list request
   */
  private async handleAgentsList(request: IPCRequest): Promise<void> {
    const payload = request.payload as { type?: string };
    const agents = await this.core.getSubAgents();
    
    const filteredAgents = payload.type
      ? agents.filter(a => a.type === payload.type)
      : agents;

    this.sendResponse(request.id, 'agents:list:response', true, {
      agents: filteredAgents.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        description: a.description,
        status: a.status,
        capabilities: a.capabilities,
        version: a.metadata?.version || '1.0.0',
      })),
    });
  }

  /**
   * Handle process request
   */
  private async handleProcessRequest(request: IPCRequest): Promise<void> {
    const payload = request.payload as {
      prompt: string;
      command?: string;
      context?: Record<string, unknown>;
      options?: {
        stream?: boolean;
        preferredAgents?: string[];
        excludeAgents?: string[];
        maxTokens?: number;
        timeout?: number;
        includeMemory?: boolean;
      };
    };

    const startTime = Date.now();

    // Create XORNG request
    const xorngRequest = {
      id: request.id,
      prompt: payload.prompt,
      timestamp: new Date(),
      context: {
        projectPath: payload.context?.projectPath as string | undefined,
        currentFile: payload.context?.currentFile as string | undefined,
        selectedCode: payload.context?.selectedCode as string | undefined,
        metadata: payload.context?.metadata as Record<string, unknown> | undefined,
      },
      options: {
        preferredAgents: payload.options?.preferredAgents,
        excludeAgents: payload.options?.excludeAgents,
        model: (payload.context?.metadata as Record<string, any> | undefined)?.model, // Propagate model metadata
      },
    };

    // If streaming is requested
    if (payload.options?.stream) {
      // For now, process normally and send result
      // Full streaming would require more complex implementation
      const response = await this.core.process(xorngRequest, this.llmClient);
      
      // Send result
      this.sendResponse(request.id, 'process:response', true, {
        content: response.content,
        subAgentResults: response.subAgentResults,
        metadata: {
          totalTokensUsed: response.metadata.totalTokensUsed,
          totalExecutionTimeMs: Date.now() - startTime,
          agentsInvoked: response.subAgentResults?.length || 0,
          memoryRetrievals: response.metadata.memoryRetrievals || 0,
        },
      });
    } else {
      const response = await this.core.process(xorngRequest, this.llmClient);
      
      this.sendResponse(request.id, 'process:response', true, {
        content: response.content,
        subAgentResults: response.subAgentResults,
        metadata: {
          totalTokensUsed: response.metadata.totalTokensUsed,
          totalExecutionTimeMs: Date.now() - startTime,
          agentsInvoked: response.subAgentResults?.length || 0,
          memoryRetrievals: response.metadata.memoryRetrievals || 0,
        },
      });
    }
  }

  /**
   * Handle token usage request
   */
  private async handleTokenUsage(request: IPCRequest): Promise<void> {
    const usage = await this.core.getTokenUsage();
    
    this.sendResponse(request.id, 'tokens:usage:response', true, {
      totalPromptTokens: usage.promptTokens,
      totalCompletionTokens: usage.completionTokens,
      estimatedCost: usage.estimatedCost,
      dailyLimit: usage.dailyLimit || 0,
    });
  }

  /**
   * Handle memory search request
   */
  private async handleMemorySearch(request: IPCRequest): Promise<void> {
    const payload = request.payload as { query: string; limit?: number };
    const results = await this.core.searchMemory(payload.query, payload.limit);
    
    this.sendResponse(request.id, 'memory:search:response', true, {
      results: results.map(r => ({
        id: r.id,
        content: r.content,
        relevance: r.relevance || 1,
        timestamp: new Date(r.timestamp).getTime(),
      })),
    });
  }

  /**
   * Handle memory clear request
   */
  private async handleMemoryClear(request: IPCRequest): Promise<void> {
    const payload = request.payload as { type?: string };
    await this.core.clearMemory(payload.type as 'short-term' | 'long-term' | 'all');
    
    this.sendResponse(request.id, 'memory:clear:response', true, {});
  }

  /**
   * Handle health check request
   */
  private async handleHealth(request: IPCRequest): Promise<void> {
    const agents = await this.core.getSubAgents();
    
    this.sendResponse(request.id, 'core:health:response', true, {
      status: 'healthy',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
      subAgentsLoaded: agents.length,
    });
  }

  /**
   * Handle shutdown request
   */
  private async handleShutdown(request: IPCRequest): Promise<void> {
    this.logger.info('Received shutdown request');
    
    // Graceful shutdown
    await this.core.shutdown();
    
    this.sendResponse(request.id, 'core:shutdown:response', true, {});
    
    // Exit after a short delay
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }

  /**
   * Send response to extension
   */
  private sendResponse(
    requestId: string,
    type: string,
    success: boolean,
    payload: unknown
  ): void {
    process.send?.({
      type,
      id: `res_${Date.now()}`,
      timestamp: Date.now(),
      requestId,
      success,
      payload,
    });
  }

  /**
   * Send error response
   */
  private sendError(requestId: string, code: string, message: string): void {
    process.send?.({
      type: 'error',
      id: `err_${Date.now()}`,
      timestamp: Date.now(),
      requestId,
      success: false,
      error: { code, message },
    });
  }

  /**
   * Type guard for IPC request
   */
  private isIPCRequest(msg: unknown): msg is IPCRequest {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      'id' in msg &&
      'timestamp' in msg
    );
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const logLevel = process.env.LOG_LEVEL || 'info';
  // Validate log level to ensure it's a valid pino level
  const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const sanitizedLevel = validLevels.includes(logLevel.toLowerCase()) ? logLevel.toLowerCase() : 'info';
  const logger = createLogger(sanitizedLevel, 'ipc-main');
  
  logger.info('XORNG Core starting in IPC mode...');

  try {
    // Load configuration
    const config = loadConfig();
    
    // Create LLM client for IPC
    const llmClient = new IPCLLMClient();
    
    // Initialize Core
    const core = new XORNGCore(config);
    await core.initialize();
    
    // Create IPC handler
    const ipcHandler = new IPCHandler(core, llmClient);
    
    // Listen for IPC messages
    process.on('message', (msg) => {
      ipcHandler.handleMessage(msg);
    });
    
    // Send ready signal to extension
    process.send?.({
      type: 'core:ready',
      id: `ready_${Date.now()}`,
      timestamp: Date.now(),
      payload: {
        version: '1.0.0',
        capabilities: ['process', 'memory', 'tokens', 'agents'],
      },
    });
    
    logger.info('XORNG Core is ready');

    // Handle process signals
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await core.shutdown();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await core.shutdown();
      process.exit(0);
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to start XORNG Core: ${errorMessage}`);
    process.exit(1);
  }
}

// Run if this is the main module
main().catch(console.error);
