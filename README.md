# XORNG Core

Central orchestration engine for the XORNG Agentic Coding Framework.

## Overview

XORNG Core acts as an MCP (Model Context Protocol) host that manages connections to multiple sub-agent MCP servers. It provides:

- **Request Routing**: Intelligent distribution of requests to appropriate sub-agents
- **Response Aggregation**: Combines results from multiple agents
- **Memory System**: Short-term, long-term, and entity memory for context management
- **Token Tracking**: Real-time token usage monitoring and cost estimation
- **Metrics Collection**: Performance monitoring and observability

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       XORNG CORE                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    XORNGCore                         │    │
│  │  - Orchestrates all components                       │    │
│  │  - Manages lifecycle                                 │    │
│  └─────────────────────────────────────────────────────┘    │
│           │                    │                    │        │
│           ▼                    ▼                    ▼        │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │  Distributor  │   │  Aggregator   │   │MemoryManager  │  │
│  │               │   │               │   │               │  │
│  │ Routes        │   │ Combines      │   │ Short-Term    │  │
│  │ requests      │   │ results       │   │ Long-Term     │  │
│  │               │   │               │   │ Entity        │  │
│  └───────────────┘   └───────────────┘   └───────────────┘  │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SubAgentManager                         │    │
│  │  - Manages MCP connections to sub-agents             │    │
│  │  - Tool discovery and invocation                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │Validator │        │Knowledge │        │  Task    │
   │  Agents  │        │  Agents  │        │  Agents  │
   └──────────┘        └──────────┘        └──────────┘
```

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key configuration options:

| Variable | Description | Default |
|----------|-------------|---------|
| `XORNG_HOST` | Server host | `0.0.0.0` |
| `XORNG_PORT` | Server port | `3000` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `LOG_LEVEL` | Logging level | `info` |
| `ENABLE_TOKEN_TRACKING` | Enable token usage tracking | `true` |
| `SUBAGENT_TIMEOUT_MS` | Sub-agent timeout | `30000` |
| `MAX_CONCURRENT_SUBAGENTS` | Max concurrent sub-agents | `10` |

## Usage

### Basic Usage

```typescript
import { XORNGCore } from '@xorng/core';

const core = new XORNGCore();

// Initialize the system
await core.initialize();

// Register sub-agents
await core.registerSubAgent({
  id: 'code-review-1',
  name: 'Code Reviewer',
  type: 'validator',
  description: 'Reviews code for quality and best practices',
  connectionType: 'stdio',
  command: 'docker',
  args: ['run', '-i', 'xorng/validator-code-review'],
  capabilities: ['code-analysis', 'linting'],
});

// Process a request
const response = await core.process({
  id: crypto.randomUUID(),
  prompt: 'Review this code for security issues',
  context: {
    currentFile: 'src/auth.ts',
    selectedCode: 'const password = "hardcoded123";',
  },
  timestamp: new Date(),
});

console.log(response.content);

// Shutdown
await core.shutdown();
```

### Memory System

```typescript
import { MemoryManager } from '@xorng/core';

const memory = new MemoryManager('redis://localhost:6379');
await memory.initialize();

// Store a memory
await memory.store({
  type: 'long-term',
  content: 'Pattern: Always use parameterized queries to prevent SQL injection',
  metadata: {
    source: 'security-review',
    tags: ['security', 'sql', 'best-practice'],
    relevance: 0.95,
  },
});

// Search memories
const results = await memory.search('SQL injection prevention', 5);
```

### Token Tracking

```typescript
import { TokenTracker } from '@xorng/core';

const tracker = new TokenTracker();

// Track usage
tracker.trackPrompt('req-123', 'Review this code...');
tracker.trackCompletion('req-123', 'The code has the following issues...');

// Get statistics
const stats = tracker.getStats();
console.log(`Total cost: $${stats.estimatedCost.toFixed(4)}`);
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## Project Structure

```
src/
├── index.ts              # Main exports
├── core/
│   ├── XORNGCore.ts      # Central orchestrator
│   ├── Distributor.ts    # Request routing
│   └── Aggregator.ts     # Response aggregation
├── agents/
│   ├── SubAgentManager.ts    # Agent lifecycle management
│   └── SubAgentConnection.ts # MCP client wrapper
├── memory/
│   ├── MemoryManager.ts  # Unified memory interface
│   ├── ShortTermMemory.ts
│   ├── LongTermMemory.ts
│   └── EntityMemory.ts
├── telemetry/
│   ├── TokenTracker.ts   # Token usage tracking
│   └── MetricsCollector.ts # Performance metrics
├── config/
│   └── index.ts          # Configuration loading
├── types/
│   └── index.ts          # TypeScript types
└── utils/
    └── logger.ts         # Logging utilities
```

## API Reference

### XORNGCore

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize the core system |
| `registerSubAgent(config)` | Register a sub-agent |
| `process(request, options?)` | Process a request |
| `getSubAgents()` | Get registered sub-agents |
| `getTokenUsage()` | Get token usage statistics |
| `shutdown()` | Shutdown the system |

### SubAgentManager

| Method | Description |
|--------|-------------|
| `registerAgent(config)` | Register and connect to an agent |
| `getConnection(agentId)` | Get agent connection |
| `getAllAgents()` | Get all registered agents |
| `getAgentsByType(type)` | Get agents by type |
| `callTool(agentId, toolName, args)` | Call a tool on an agent |
| `disconnectAll()` | Disconnect all agents |

### MemoryManager

| Method | Description |
|--------|-------------|
| `initialize()` | Initialize memory stores |
| `store(input)` | Store a memory entry |
| `search(query, limit?, options?)` | Search for memories |
| `get(id, type)` | Get a specific entry |
| `delete(id, type)` | Delete an entry |
| `clearShortTerm()` | Clear short-term memory |
| `getStats()` | Get memory statistics |

## License

MIT
