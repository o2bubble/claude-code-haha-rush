import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getToolDefinitions, handleToolCall } from './tools.js';

export async function runCdpInspectorServer(): Promise<void> {
  const server = new Server(
    { name: 'cdp-inspector', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, (args || {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: result }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();

  // Exit cleanly when the parent process closes stdin
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));

  await server.connect(transport);
}
