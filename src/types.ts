import type { Client } from "@modelcontextprotocol/client";

/**
 * MCP Server configuration types.
 */
/**
 * A single MCP tool's metadata, as returned by tools/list.
 *
 * `inputSchema` is kept so describe() can return it on demand.
 * The system prompt only lists tool names + descriptions — schemas are
 * fetched reactively via mcp(describe="tool_name").
 */
export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: unknown;
}

export type ServerConfig =
	| { type: "local"; command: string[]; env?: Record<string, string>; cwd?: string; label?: string }
	| { type: "remote"; url: string; headers?: Record<string, string>; label?: string };

/**
 * Runtime state for a connected MCP server.
 */
export interface McpClientInfo {
	client: Client;
	name: string;        // config label / display name
	tools: McpToolInfo[];
	hasPrompts: boolean;
	hasResources: boolean;
	serverInstructions: string | undefined; // server-provided instructions from the handshake
	instructions: string; // generated instruction block for this server
}
