/**
 * XORNG Core - Central Orchestration Engine
 * 
 * This is the main entry point for the XORNG system.
 * It acts as an MCP host that manages connections to multiple sub-agent MCP servers.
 */

export { XORNGCore, type LLMClient } from './core/XORNGCore.js';
export { Distributor } from './core/Distributor.js';
export { Aggregator } from './core/Aggregator.js';

// Memory System
export { MemoryManager } from './memory/MemoryManager.js';
export { ShortTermMemory } from './memory/ShortTermMemory.js';
export { LongTermMemory } from './memory/LongTermMemory.js';
export { EntityMemory } from './memory/EntityMemory.js';

// Sub-agent Management
export { SubAgentManager } from './agents/SubAgentManager.js';
export { SubAgentConnection } from './agents/SubAgentConnection.js';

// Token Tracking
export { TokenTracker } from './telemetry/TokenTracker.js';
export { MetricsCollector } from './telemetry/MetricsCollector.js';

// Learning System
export { LearningService } from './learning/LearningService.js';
export type {
  FixPattern,
  FixAttemptRecord,
  SelfImprovementMetrics,
  LearningServiceConfig,
} from './learning/LearningService.js';

// Types
export * from './types/index.js';

// Configuration
export { loadConfig, type XORNGConfig } from './config/index.js';

// Logger
export { createLogger, type Logger } from './utils/logger.js';
