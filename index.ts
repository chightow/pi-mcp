/**
 * MCP (Model Context Protocol) Extension
 *
 * Connects to MCP servers and exposes their tools through a single `mcp`
 * dispatch tool. Prompts and resources each get their own per-server
 * dispatch tool (mcp_${slug}_prompts, mcp_${slug}_resources).
 *
 * Features:
 * - Stdio transport (local servers like npx, uvx, node)
 * - HTTP/SSE transport (remote servers)
 * - Streamable HTTP transport (MCP spec 2025-11-25+) with SSE fallback
 * - Server tool lists injected into the system prompt
 * - Discovery from .mcp.json (OpenCode format) and .pi/mcp.json (pi format)
 *
 * Usage:
 *   pi -e ./mcp
 *
 * Config file format (.pi/mcp.json):
 *     {
 *       "servers": {
 *         "fs": {
 *           "type": "local",
 *           "command": ["npx", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *         },
 *         "web": {
 *           "type": "remote",
 *           "url": "https://my-server.example.com/mcp"
 *         }
 *       }
 *     }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveServerConfigs } from "./src/config.ts";
import { connectToServerWithVersion, TransportError } from "./src/transport.ts";
import {
	collectServerCapabilities,
	registerPromptsFromServer,
	registerResourcesFromServer,
	mapContent,
	setupToolChangeWatcher,
	setupPromptChangeNotification,
	setupResourceChangeNotification,
	buildServerInstructions,
	toolSlug,
} from "./src/tools.ts";
import type { Client } from "@modelcontextprotocol/client";
import type { McpClientInfo, ServerConfig } from "./src/types.ts";

// ============================================================================
// Extension
// ============================================================================

export default function mcpExtension(pi: ExtensionAPI) {
	let mcpClients = new Map<string, McpClientInfo>();
	let mcpToolRegistered = false;

	function resetState(): void {
		mcpClients.clear();
		// mcpToolRegistered intentionally not reset — the dispatch tool is registered once globally
		// and persists across sessions.
	}

	function rebuildPromptBlock(): string | undefined {
		if (mcpClients.size === 0) return undefined;
		const lines = [...mcpClients.values()].flatMap(({ instructions }) =>
			instructions.split("\n").map((l) => "  " + l),
		);
		return "<mcp_instructions>\n" + lines.join("\n") + "\n</mcp_instructions>";
	}

	function refreshStatus(ctx: ExtensionContext): void {
		const totalTools = [...mcpClients.values()].reduce((sum, c) => sum + c.tools.length, 0);
		const totalServers = mcpClients.size;
		ctx.ui.setStatus(
			"mcp",
			ctx.ui.theme.fg("accent", `MCP: ${totalServers} server(s) | ${totalTools} tools`),
		);
	}

	function clearStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mcp", undefined);
	}

	// Guard oversized text output (matches pi's bash guard limits)
	const MAX_OUTPUT_BYTES = 51_200;
	const MAX_OUTPUT_LINES = 2_000;

	function guardText(text: string): string {
		if (text.length <= MAX_OUTPUT_BYTES) {
			const lines = text.split("\n");
			if (lines.length <= MAX_OUTPUT_LINES) return text;
			return lines.slice(0, MAX_OUTPUT_LINES).join("\n") + "\n... [output truncated at 2000 lines]";
		}
		return text.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 50 KiB]";
	}

	// Register the global mcp dispatch tool once
	function ensureMcpTool(pi: ExtensionAPI): void {
		if (mcpToolRegistered) return;
		mcpToolRegistered = true;

		pi.registerTool({
			name: "mcp",
			label: "MCP",
			description: [
				"Call a tool on a connected MCP server, search available tools, or describe a tool's schema.",
				"",
				"The <mcp_instructions> block lists available servers and their tool names.",
				"To call a tool: set server + tool + arguments.",
				"Arguments are passed as a flat object (string key-value pairs).",
				"",
				"If you don't know a tool's parameters, use describe first:",
				'  mcp(describe="tool_name")   — returns the JSON schema for that tool',
				'  mcp(search="keyword")       — finds tools matching a name or description',
				"",
				"For prompts and resources, use the dedicated dispatch tools listed in the instructions.",
			].join("\n"),
			promptSnippet: "[MCP] Call tools on connected MCP servers",
			parameters: Type.Object({
				server: Type.Optional(Type.String({ description: "Server name (required when calling a tool)" })),
				tool: Type.Optional(Type.String({ description: "Tool name to call" })),
				arguments: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Unknown({ description: "Tool argument values" }),
					),
				),
				describe: Type.Optional(Type.String({ description: "Tool name to describe (returns its JSON schema)" })),
				search: Type.Optional(Type.String({ description: "Search tools by name or keyword across all servers" })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				const p = params as {
					server?: string;
					tool?: string;
					arguments?: Record<string, unknown>;
					describe?: string;
					search?: string;
				};

				// describe: fetch a tool's JSON schema by name
				if (p.describe) {
					const name = p.describe;
					for (const [, info] of mcpClients) {
						const found = info.tools.find((t) => t.name === name);
						if (found) {
							return {
								content: [{ type: "text" as const, text: JSON.stringify(found.inputSchema, null, 2) }],
								details: {},
								isError: false,
							};
						}
					}
					return {
						content: [{ type: "text", text: `Tool "${name}" not found in any connected server` }],
						details: {},
						isError: true,
					};
				}

				// search: find tools by name or keyword across all servers
				if (p.search) {
					const query = p.search.toLowerCase();
					const results: string[] = [];
					for (const [, info] of mcpClients) {
						for (const t of info.tools) {
							if (t.name.toLowerCase().includes(query) ||
								(t.description?.toLowerCase().includes(query))) {
								results.push(`  ${info.name}.${t.name}: ${t.description ?? "(no description)"}`);
							}
						}
					}
					if (results.length === 0) {
						return {
							content: [{ type: "text" as const, text: `No tools found matching "${p.search}"` }],
							details: {},
							isError: false,
						};
					}
					return {
						content: [{ type: "text" as const, text: `Matching tools:\n${results.join("\n")}` }],
						details: {},
						isError: false,
					};
				}

				// tool call path
				if (!p.server || !p.tool) {
					return {
						content: [{ type: "text", text: "Set 'server' and 'tool' to call a tool, or use 'describe' or 'search'." }],
						details: {},
						isError: true,
					};
				}

				const clientInfo = mcpClients.get(p.server);
				if (!clientInfo) {
					const available = [...mcpClients.keys()].join(", ") || "none";
					return {
						content: [{
							type: "text" as const,
							text: `MCP server "${p.server}" is not connected. Available servers: ${available}`,
						}],
						details: {},
						isError: true,
					};
				}

				try {
					const result = await clientInfo.client.callTool(
						{ name: p.tool, arguments: p.arguments as Record<string, unknown> },
						{ signal },
					);

					const rawContent = result.content;
					const content = Array.isArray(rawContent)
						? rawContent.map((c: unknown) => {
								const mapped = mapContent(c as Record<string, unknown>);
								if (mapped.type === "text") mapped.text = guardText(mapped.text);
								return mapped;
							})
						: [{ type: "text" as const, text: `[Tool result contained no content array: ${JSON.stringify(rawContent)}]` }];

					return {
						content,
						details: {},
						isError: result.isError === true,
					};
				} catch (err) {
					// If the caller cancelled (user pressed escape), don't
					// disconnect the server — the error is about the abort,
					// not a transport failure.
					if (signal?.aborted) {
						return {
							content: [{ type: "text", text: "Tool call was cancelled." }],
							details: {},
							isError: true,
						};
					}

					const message = err instanceof Error ? err.message : String(err);
					const detail = err instanceof Error && err.cause ? String(err.cause) : undefined;

					// Transport-level error means this server is dead. Remove it
					// so the LLM doesn't retry — subsequent attempts will get
					// "not connected" immediately instead of hanging again.
					const deadServer = mcpClients.get(p.server);
					if (deadServer) {
						mcpClients.delete(p.server);
						deadServer.client.close().catch(() => {});
					}

					return {
						content: [{
							type: "text",
							text: `MCP tool "${p.tool}" on server "${p.server}" error: ${message}${detail ? `\nDetails: ${detail}` : ""}\n\nServer "${p.server}" has been disconnected. Its tools are no longer available this session.`,
						}],
						details: { error: message, ...(detail ? { cause: detail } : {}) },
						isError: true,
					};
				}
			},
		});
	}

	// Register /mcp command to show status
	pi.registerCommand("mcp", {
		description: "Show MCP server status",
		handler: async (_args, ctx) => {
			if (mcpClients.size === 0) {
				ctx.ui.notify("MCP: no servers connected", "info");
				return;
			}
			const lines = [...mcpClients.entries()].map(([name, info]) =>
				`${name}: ${info.tools.length} tools${info.hasPrompts ? ", prompts" : ""}${info.hasResources ? ", resources" : ""}`,
			);
			ctx.ui.notify(`MCP servers:\n  ${lines.join("\n  ")}`, "info");
		},
	});

	// Inject MCP server instructions into the system prompt each turn
	pi.on("before_agent_start", async (event) => {
		const block = rebuildPromptBlock();
		if (!block) return;
		const sep = event.systemPrompt.length > 0 ? "\n\n" : "";
		return { systemPrompt: event.systemPrompt + sep + block };
	});

	async function connectServer(config: ServerConfig, ctx: ExtensionContext): Promise<void> {
		const label = config.label ??
			(config.type === "remote" ? config.url : config.command.join(" "));

		try {
			const { client } = await connectToServerWithVersion(config, label, VERSION);
			try {
				await setupServerClient(client, label, ctx);
			} catch (err) {
				// Close the client if setup failed after connection succeeded
				await client.close().catch(() => {});
				throw err;
			}
		} catch (err) {
			const message = err instanceof TransportError || err instanceof Error
				? err.message
				: String(err);
			ctx.ui.notify(`MCP "${label}" failed: ${message}`, "error");
		}
	}

	async function setupServerClient(client: Client, label: string, ctx: ExtensionContext): Promise<void> {
		const serverInfo = client.getServerVersion();
		const displayName = serverInfo?.name ?? label;

		ctx.ui.notify(
			`MCP: connected to ${serverInfo?.name ?? "unknown"} v${serverInfo?.version ?? "?"} (${label})`,
			"info",
		);

		// Collect capabilities (tool names, prompt/resource presence)
		const caps = await collectServerCapabilities(client, AbortSignal.timeout(30_000));

		if (caps.tools.length === 0 && !caps.hasPrompts && !caps.hasResources) {
			ctx.ui.notify(`MCP: disconnected from ${displayName} (no tools, prompts, or resources available)`, "warning");
			try {
				await client.close();
			} catch {
				ctx.ui.notify(`MCP: error closing connection to ${displayName}`, "warning");
			}
			return;
		}

		// Ensure the global mcp tool is registered (first server to connect does this)
		ensureMcpTool(pi);

		// Register dispatch tools for prompts and resources
		await Promise.all([
			caps.hasPrompts
				? registerPromptsFromServer(client, displayName, pi, (msg, level) =>
						ctx.ui.notify(msg, level),
					)
				: Promise.resolve(),
			caps.hasResources
				? registerResourcesFromServer(client, displayName, pi, (msg, level) =>
						ctx.ui.notify(msg, level),
					)
				: Promise.resolve(),
		]);

		// Build instruction block for this server
		const slug = toolSlug(displayName);
		const instructions = buildServerInstructions(
			label,
			caps.tools,
			caps.hasPrompts,
			caps.hasResources,
			caps.serverInstructions,
			slug,
		);

		// Close existing client with the same name (avoid resource leak on label collision)
		const existing = mcpClients.get(label);
		if (existing) {
			ctx.ui.notify(`MCP: replacing existing connection "${label}"`, "warning");
			await existing.client.close().catch(() => {});
		}

		// Store client info
		const info: McpClientInfo = {
			client,
			name: label,
			tools: caps.tools,
			hasPrompts: caps.hasPrompts,
			hasResources: caps.hasResources,
			serverInstructions: caps.serverInstructions,
			instructions,
		};
		mcpClients.set(info.name, info);

		// Clean up on disconnect — set immediately so the entry is cleaned
		// up even if subsequent async setup fails.
		const existingOnClose = client.onclose;
		client.onclose = () => {
			existingOnClose?.();
			mcpClients.delete(info.name);
			refreshStatus(ctx);
		};

		// Listen for tool list changes — re-collect capabilities and update state
		await setupToolChangeWatcher(client, (msg, level) => ctx.ui.notify(msg, level), (updated) => {
			info.tools = updated.tools;
			info.serverInstructions = updated.serverInstructions;
			info.instructions = buildServerInstructions(
				label,
				info.tools,
				info.hasPrompts,
				info.hasResources,
				info.serverInstructions,
				slug,
			);

			if (info.tools.length === 0) {
				ctx.ui.notify(`MCP: all tools removed from "${displayName}"`, "warning");
			}
			refreshStatus(ctx);
		});

		// Listen for prompt/resource list changes
		await Promise.all([
			setupPromptChangeNotification(client, displayName, pi, (msg, level) =>
				ctx.ui.notify(msg, level),
				(hasPrompts) => {
					info.hasPrompts = hasPrompts;
					info.instructions = buildServerInstructions(
						label,
						info.tools,
						info.hasPrompts,
						info.hasResources,
						info.serverInstructions,
						slug,
					);
					refreshStatus(ctx);
				},
			),
			setupResourceChangeNotification(client, displayName, pi, (msg, level) =>
				ctx.ui.notify(msg, level),
				(hasResources) => {
					info.hasResources = hasResources;
					info.instructions = buildServerInstructions(
						label,
						info.tools,
						info.hasPrompts,
						info.hasResources,
						info.serverInstructions,
						slug,
					);
					refreshStatus(ctx);
				},
			),
		]);

		refreshStatus(ctx);
		ctx.ui.notify(`MCP: connected ${displayName} (${caps.tools.length} tools${caps.hasPrompts ? ", prompts" : ""}${caps.hasResources ? ", resources" : ""})`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		resetState();
		const configs = resolveServerConfigs(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));

		if (configs.length === 0) return;

		// Deduplicate by label — when .mcp.json and .pi/mcp.json define the
		// same server, .pi/mcp.json (loaded second) wins. Without this,
		// concurrent connectServer calls race on same-label Map writes.
		const seen = new Map<string, ServerConfig>();
		for (const cfg of configs) {
			const key = cfg.label ?? `${cfg.type === "local" ? cfg.command.join(" ") : cfg.url}`;
			seen.set(key, cfg);
		}

		await Promise.all([...seen.values()].map((cfg) => connectServer(cfg, ctx)));
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await Promise.all(
			[...mcpClients.values()].map(async ({ client }) => {
				try {
					await client.close();
				} catch {
					// ignore close errors during shutdown
				}
			}),
		);
		resetState();
		clearStatus(ctx);
	});
}
