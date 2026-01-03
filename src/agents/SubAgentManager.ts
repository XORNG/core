import type { SubAgent, SubAgentType } from '../types/index.js';
import { SubAgentConnection } from './SubAgentConnection.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Configuration for a sub-agent
 */
export interface SubAgentConfig {
  id: string;
  name: string;
  type: SubAgentType;
  description: string;
  connectionType: 'stdio' | 'http' | 'virtual';
  // For stdio connections
  command?: string;
  args?: string[];
  // For HTTP connections
  endpoint?: string;
  // Capabilities this agent provides
  capabilities: string[];
}

/**
 * Manages all sub-agent connections in the XORNG system
 */
export class SubAgentManager {
  private connections: Map<string, SubAgentConnection> = new Map();
  private logger: Logger;
  private maxConcurrent: number;

  constructor(
    maxConcurrent: number = 10,
    logLevel: string = 'info'
  ) {
    this.maxConcurrent = maxConcurrent;
    this.logger = createLogger(logLevel, 'subagent-manager');
  }

  /**
   * Register and connect to a new sub-agent
   */
  async registerAgent(config: SubAgentConfig): Promise<void> {
    this.logger.info({ agentId: config.id, agentName: config.name }, 'Registering sub-agent');

    if (this.connections.has(config.id)) {
      throw new Error(`Agent with id ${config.id} is already registered`);
    }

    const agent: SubAgent = {
      id: config.id,
      name: config.name,
      type: config.type,
      description: config.description,
      status: 'disconnected',
      endpoint: config.endpoint || config.command || '',
      capabilities: config.capabilities,
      metadata: {},
    };

    const connection = new SubAgentConnection(agent);
    this.connections.set(config.id, connection);

    // Connect based on connection type
    try {
      if (config.connectionType === 'virtual') {
        // Virtual agents don't need external connections
        // They're processed by the orchestrator using the LLM client
        agent.status = 'idle';
        this.logger.info({ agentId: config.id }, 'Virtual sub-agent registered');
      } else if (config.connectionType === 'stdio' && config.command) {
        await connection.connectStdio(config.command, config.args || []);
      } else if (config.connectionType === 'http' && config.endpoint) {
        await connection.connectHttp(config.endpoint);
      } else {
        throw new Error('Invalid connection configuration');
      }

      this.logger.info({ agentId: config.id }, 'Sub-agent registered and connected');
    } catch (error) {
      this.logger.error({ agentId: config.id, error }, 'Failed to connect sub-agent');
      // Keep the connection registered but in error state
    }
  }

  /**
   * Get a specific sub-agent connection
   */
  getConnection(agentId: string): SubAgentConnection | undefined {
    return this.connections.get(agentId);
  }

  /**
   * Get all registered agents
   */
  getAllAgents(): SubAgent[] {
    return Array.from(this.connections.values()).map(conn => conn.agent);
  }

  /**
   * Get agents by type
   */
  getAgentsByType(type: SubAgentType): SubAgent[] {
    return this.getAllAgents().filter(agent => agent.type === type);
  }

  /**
   * Get agents by capability
   */
  getAgentsByCapability(capability: string): SubAgent[] {
    return this.getAllAgents().filter(agent => 
      agent.capabilities.includes(capability)
    );
  }

  /**
   * Get all available tools across all connected agents
   */
  getAllTools(): Map<string, { agentId: string; tool: unknown }> {
    const allTools = new Map<string, { agentId: string; tool: unknown }>();

    for (const [agentId, connection] of this.connections) {
      if (connection.status === 'idle' || connection.status === 'busy') {
        for (const [toolName, tool] of connection.getTools()) {
          // Namespace tools by agent to avoid conflicts
          allTools.set(`${agentId}:${toolName}`, { agentId, tool });
        }
      }
    }

    return allTools;
  }

  /**
   * Call a tool on a specific agent
   */
  async callTool(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown; isError?: boolean }> {
    const connection = this.connections.get(agentId);
    
    if (!connection) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return connection.callTool(toolName, args);
  }

  /**
   * Call a tool on any agent that has it
   */
  async callToolAny(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ agentId: string; content: unknown; isError?: boolean }> {
    for (const [agentId, connection] of this.connections) {
      if (connection.getTools().has(toolName)) {
        const result = await connection.callTool(toolName, args);
        return { agentId, ...result };
      }
    }

    throw new Error(`Tool ${toolName} not found on any agent`);
  }

  /**
   * Unregister and disconnect a sub-agent
   */
  async unregisterAgent(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId);
    
    if (connection) {
      await connection.disconnect();
      this.connections.delete(agentId);
      this.logger.info({ agentId }, 'Sub-agent unregistered');
    }
  }

  /**
   * Disconnect all sub-agents
   */
  async disconnectAll(): Promise<void> {
    this.logger.info('Disconnecting all sub-agents');
    
    const disconnectPromises = Array.from(this.connections.values()).map(
      conn => conn.disconnect()
    );
    
    await Promise.all(disconnectPromises);
    this.connections.clear();
  }

  /**
   * Get current active connection count
   */
  getActiveCount(): number {
    return Array.from(this.connections.values()).filter(
      conn => conn.status !== 'disconnected'
    ).length;
  }

  /**
   * Check if we can accept more connections
   */
  canAcceptConnection(): boolean {
    return this.getActiveCount() < this.maxConcurrent;
  }
}
