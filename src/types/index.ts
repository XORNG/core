import { z } from 'zod';

/**
 * Sub-agent types supported by XORNG
 */
export type SubAgentType = 'validator' | 'knowledge' | 'task' | 'dynamic';

/**
 * Status of a sub-agent
 */
export type SubAgentStatus = 'idle' | 'busy' | 'error' | 'disconnected';

/**
 * Represents a sub-agent in the XORNG system
 */
export interface SubAgent {
  id: string;
  name: string;
  type: SubAgentType;
  description: string;
  status: SubAgentStatus;
  endpoint: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
}

/**
 * Request to be processed by the XORNG system
 */
export interface XORNGRequest {
  id: string;
  prompt: string;
  context?: RequestContext;
  options?: RequestOptions;
  timestamp: Date;
}

/**
 * Context for a request
 */
export interface RequestContext {
  projectPath?: string;
  currentFile?: string;
  selectedCode?: string;
  recentFiles?: string[];
  conversationHistory?: ConversationMessage[];
  metadata?: Record<string, unknown>;
}

/**
 * Options for a request
 */
export interface RequestOptions {
  maxTokens?: number;
  timeout?: number;
  preferredAgents?: string[];
  excludeAgents?: string[];
  parallel?: boolean;
  model?: string | any; // Model preference
}

/**
 * A message in a conversation
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
}

/**
 * Represents a tool call made during processing
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/**
 * Response from the XORNG system
 */
export interface XORNGResponse {
  id: string;
  requestId: string;
  content: string;
  subAgentResults: SubAgentResult[];
  metadata: ResponseMetadata;
  timestamp: Date;
}

/**
 * Result from a sub-agent
 */
export interface SubAgentResult {
  agentId: string;
  agentName: string;
  agentType: SubAgentType;
  content: string;
  confidence: number;
  tokensUsed: number;
  executionTimeMs: number;
  toolsUsed: string[];
}

/**
 * Metadata about a response
 */
export interface ResponseMetadata {
  totalTokensUsed: number;
  totalExecutionTimeMs: number;
  agentsInvoked: number;
  memoryRetrievals: number;
  cached: boolean;
}

/**
 * Memory entry for the XORNG system
 */
export interface MemoryEntry {
  id: string;
  type: 'short-term' | 'long-term' | 'entity';
  content: string;
  embedding?: number[];
  metadata: MemoryMetadata;
  timestamp: Date;
  expiresAt?: Date;
}

/**
 * Metadata for a memory entry
 */
export interface MemoryMetadata {
  source: string;
  relevance: number;
  accessCount: number;
  lastAccessed: Date;
  tags: string[];
  projectId?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Configuration for routing requests
 */
export interface RoutingDecision {
  primaryAgents: string[];
  secondaryAgents: string[];
  memoryQueries: string[];
  estimatedTokens: number;
  reasoning: string;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  model: string;
}

/**
 * Validation schemas using Zod
 */
export const RequestSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1),
  context: z.object({
    projectPath: z.string().optional(),
    currentFile: z.string().optional(),
    selectedCode: z.string().optional(),
    recentFiles: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).optional(),
  options: z.object({
    maxTokens: z.number().positive().optional(),
    timeout: z.number().positive().optional(),
    preferredAgents: z.array(z.string()).optional(),
    excludeAgents: z.array(z.string()).optional(),
    parallel: z.boolean().optional(),
  }).optional(),
  timestamp: z.date(),
});

export type ValidatedRequest = z.infer<typeof RequestSchema>;
