import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SubAgent, SubAgentStatus } from '../types/index.js';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Represents a connection to a sub-agent MCP server
 */
export class SubAgentConnection {
  private client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private logger: Logger;
  private _status: SubAgentStatus = 'disconnected';
  private tools: Map<string, unknown> = new Map();
  private resources: Map<string, unknown> = new Map();

  constructor(
    public readonly agent: SubAgent,
    logLevel: string = 'info'
  ) {
    this.client = new Client({
      name: `xorng-client-${agent.id}`,
      version: '1.0.0',
    });
    this.logger = createLogger(logLevel, `subagent-${agent.name}`);
  }

  get status(): SubAgentStatus {
    return this._status;
  }

  /**
   * Check if this is a virtual agent (no external process)
   */
  get isVirtual(): boolean {
    return this._isVirtual;
  }

  private _isVirtual = false;

  /**
   * Mark this connection as a virtual agent (no external MCP server)
   * Virtual agents are processed using the LLM client proxy
   */
  setVirtual(): void {
    this._isVirtual = true;
    this._status = 'idle';
    this.agent.status = 'idle';
    this.logger.info('Marked as virtual agent');
  }

  /**
   * Connect to the sub-agent via stdio (for local Docker containers)
   */
  async connectStdio(command: string, args: string[] = []): Promise<void> {
    this.logger.info({ command, args }, 'Connecting to sub-agent via stdio');

    try {
      this.transport = new StdioClientTransport({
        command,
        args,
      });

      await this.client.connect(this.transport);
      this._status = 'idle';
      await this.discoverCapabilities();
      
      this.logger.info('Successfully connected to sub-agent');
    } catch (error) {
      this._status = 'error';
      this.logger.error({ error }, 'Failed to connect to sub-agent');
      throw error;
    }
  }

  /**
   * Connect to the sub-agent via HTTP (for remote servers)
   */
  async connectHttp(url: string): Promise<void> {
    this.logger.info({ url }, 'Connecting to sub-agent via HTTP');

    try {
      this.transport = new StreamableHTTPClientTransport(new URL(url));
      await this.client.connect(this.transport);
      this._status = 'idle';
      await this.discoverCapabilities();
      
      this.logger.info('Successfully connected to sub-agent');
    } catch (error) {
      this._status = 'error';
      this.logger.error({ error }, 'Failed to connect to sub-agent');
      throw error;
    }
  }

  /**
   * Discover tools and resources from the sub-agent
   */
  private async discoverCapabilities(): Promise<void> {
    this.logger.debug('Discovering sub-agent capabilities');

    try {
      // List available tools
      const toolsResponse = await this.client.listTools();
      this.tools.clear();
      for (const tool of toolsResponse.tools) {
        this.tools.set(tool.name, tool);
        this.logger.debug({ toolName: tool.name }, 'Discovered tool');
      }

      // List available resources
      const resourcesResponse = await this.client.listResources();
      this.resources.clear();
      for (const resource of resourcesResponse.resources) {
        this.resources.set(resource.uri, resource);
        this.logger.debug({ resourceUri: resource.uri }, 'Discovered resource');
      }

      this.logger.info({
        toolCount: this.tools.size,
        resourceCount: this.resources.size,
      }, 'Capability discovery complete');
    } catch (error) {
      this.logger.error({ error }, 'Failed to discover capabilities');
    }
  }

  /**
   * Call a tool on the sub-agent
   */
  async callTool(
    name: string, 
    args: Record<string, unknown>
  ): Promise<{ content: unknown; isError?: boolean }> {
    if (this._status === 'disconnected') {
      throw new Error('Sub-agent is not connected');
    }

    this._status = 'busy';
    this.logger.debug({ name, args }, 'Calling tool');

    try {
      const result = await this.client.callTool({ name, arguments: args });
      this._status = 'idle';
      
      this.logger.debug({ name, result }, 'Tool call completed');
      return {
        content: result.content,
        isError: Boolean(result.isError),
      };
    } catch (error) {
      this._status = 'error';
      this.logger.error({ name, error }, 'Tool call failed');
      throw error;
    }
  }

  /**
   * Read a resource from the sub-agent
   */
  async readResource(uri: string): Promise<unknown> {
    if (this._status === 'disconnected') {
      throw new Error('Sub-agent is not connected');
    }

    this.logger.debug({ uri }, 'Reading resource');

    try {
      const result = await this.client.readResource({ uri });
      return result.contents;
    } catch (error) {
      this.logger.error({ uri, error }, 'Failed to read resource');
      throw error;
    }
  }

  /**
   * Get all available tools
   */
  getTools(): Map<string, unknown> {
    return new Map(this.tools);
  }

  /**
   * Get all available resources
   */
  getResources(): Map<string, unknown> {
    return new Map(this.resources);
  }

  /**
   * Disconnect from the sub-agent
   */
  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from sub-agent');
    
    try {
      await this.client.close();
      this._status = 'disconnected';
    } catch (error) {
      this.logger.error({ error }, 'Error during disconnect');
    }
  }
}
