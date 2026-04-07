const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { buildOpenClawToolCatalog } = require('./openclawToolCatalog');
const openclawIntegrationService = require('./openclawIntegrationService');

class OpenClawMcpService {
  constructor() {
    this.app = null;
  }

  setApp(app) {
    this.app = app;
  }

  buildServerContext(integration) {
    const integrationName = integration?.displayName || 'HomeBrain OpenClaw Admin';

    return {
      app: this.app,
      integrationName,
      actor: `openclaw:${integrationName}`
    };
  }

  buildServer(integration) {
    const context = this.buildServerContext(integration);
    const server = new McpServer({
      name: 'homebrain-admin',
      version: '1.0.0'
    }, {
      capabilities: {
        logging: {}
      }
    });

    const tools = buildOpenClawToolCatalog(context);
    tools.forEach((tool) => {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      }, tool.handler);
    });

    server.registerResource(
      'homebrain-admin-skill',
      'homebrain://guides/homebrain-admin-skill',
      {
        title: 'HomeBrain Admin Skill',
        description: 'Canonical OpenClaw skill instructions for operating HomeBrain.',
        mimeType: 'text/markdown'
      },
      async () => ({
        contents: [
          {
            uri: 'homebrain://guides/homebrain-admin-skill',
            text: await openclawIntegrationService.getSkillMarkdown()
          }
        ]
      })
    );

    server.registerResource(
      'homebrain-jetson-guide',
      'homebrain://guides/jetson-openclaw-setup',
      {
        title: 'Jetson OpenClaw Setup',
        description: 'Deployment instructions for enabling the HomeBrain OpenClaw MCP connection on Jetson.',
        mimeType: 'text/markdown'
      },
      async () => ({
        contents: [
          {
            uri: 'homebrain://guides/jetson-openclaw-setup',
            text: await openclawIntegrationService.getJetsonGuideMarkdown()
          }
        ]
      })
    );

    return server;
  }

  async handleRequest(req, res, integration) {
    const server = this.buildServer(integration);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      try {
        transport.close();
      } catch (_error) {
        // No-op.
      }

      try {
        server.close();
      } catch (_error) {
        // No-op.
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('OpenClaw MCP request failed:', error.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    } finally {
      if (res.writableEnded || res.destroyed) {
        cleanup();
      }
    }
  }
}

module.exports = new OpenClawMcpService();
