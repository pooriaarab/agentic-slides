import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { COMMAND } from "./brand.js";
import { VERSION } from "./version.js";

export function createMcpServer(): McpServer {
  return new McpServer({ name: COMMAND, version: VERSION });
}

export async function startMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
