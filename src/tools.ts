/**
 * MCP tool dispatching and content mapping.
 *
 * Registers three dispatch-style tools per server:
 * - mcp (global, for tool calls)
 * - mcp_${slug}_prompts (per server, for prompt listing and retrieval)
 * - mcp_${slug}_resources (per server, for resource listing and reading)
 *
 * Individual MCP tool schemas are NOT converted to pi ToolDefinitions.
 * Instead, MCP tool lists are injected into the system prompt as
 * instructions and accessed through the single `mcp` dispatch tool.
 */

import type { Client } from "@modelcontextprotocol/client";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpToolInfo } from "./types.ts";

/** Notification callback shared across prompt/resource registration functions. */
export type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

// ---------------------------------------------------------------------------
// Content mapping (used by the mcp tool execute handler)
// ---------------------------------------------------------------------------

/**
 * MCP tool result content mapped to pi ToolContent format.
 */
export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Map MCP tool result content to pi tool result content format.
 * Handles all standard MCP content types per the specification.
 */
export function mapContent(c: Record<string, unknown>): ToolContent {
	switch (c.type) {
		case "text":
			return { type: "text", text: String(c.text ?? "") };

		case "image": {
			const data = c.data;
			if (typeof data !== "string") break;
			return {
				type: "image",
				data,
				mimeType: typeof c.mimeType === "string" ? c.mimeType : "image/png",
			};
		}

		// Audio has the same data/mimeType shape as image
		case "audio":
			return {
				type: "text",
				text: `[Audio content: ${typeof c.mimeType === "string" ? c.mimeType : "unknown type"}]`,
			};

		// resource_link: a URI reference readable via the resources dispatch tool.
		case "resource_link": {
			const uri = typeof c.uri === "string" ? c.uri : "unknown";
			const rname = typeof c.name === "string" ? c.name : "unknown";
			return {
				type: "text",
				text: `[Resource link: ${rname} (${uri})]`,
			};
		}

		case "resource":
		case "embedded-resource":
			return mapResourceContent(c);

		case "context": {
			const doc = c.document != null && typeof c.document === "object"
				? (c.document as Record<string, unknown>)
				: {};
			const docText = doc.text ?? doc.content ?? JSON.stringify(doc);
			return { type: "text", text: String(docText) };
		}
	}

	// Fallback: serialize unknown types as text
	return { type: "text", text: JSON.stringify(c) };
}

/**
 * Extract a readable text string from an MCP resource object.
 * Handles text, blob, and uri shapes per the MCP specification.
 */
function resourceToText(resource: Record<string, unknown>): string {
	if (typeof resource.text === "string") return resource.text;
	if (typeof resource.blob === "string") {
		return `[Resource: ${String(resource.uri ?? "unknown")} (binary, ${typeof resource.mimeType === "string" ? resource.mimeType : "unknown type"})]`;
	}
	if (typeof resource.uri === "string") return resource.uri;
	return JSON.stringify(resource);
}

/**
 * Map an MCP resource or embedded-resource content block to pi text.
 */
function mapResourceContent(c: Record<string, unknown>): ToolContent {
	const resource = c.resource as Record<string, unknown> | undefined;
	if (!resource) {
		return {
			type: "text",
			text: `[${String(c.type)}: missing resource data]`,
		};
	}
	return { type: "text", text: resourceToText(resource) };
}

// ---------------------------------------------------------------------------
// Server capability collection (for building instructions / status)
// ---------------------------------------------------------------------------

export interface ServerCapabilities {
	tools: McpToolInfo[];
	hasPrompts: boolean;
	hasResources: boolean;
	serverInstructions: string | undefined;
}

/**
 * Collect tool names and server instructions from an MCP client.
 */
export async function collectServerCapabilities(client: Client, signal?: AbortSignal): Promise<ServerCapabilities> {
	const [tools, prompts, resources] = await Promise.all([
		listAllTools(client, signal),
		listAllPrompts(client, signal),
		listAllResources(client, signal),
	]);

	return {
		tools,
		hasPrompts: prompts.length > 0,
		hasResources: resources.length > 0,
		serverInstructions: client.getInstructions()?.trim(),
	};
}

// ---------------------------------------------------------------------------
// Shared helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Sanitize a server name/label into a safe tool name fragment.
 */
export function toolSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
	return slug || "mcp";
}

// ---------------------------------------------------------------------------
// Instruction-block construction (injected into the system prompt)
// ---------------------------------------------------------------------------

/**
 * Render a single MCP tool as an instruction-block entry.
 *
 * Schema is deliberately excluded — call mcp(describe="tool_name") to fetch
 * the full JSON Schema on demand. Keeping the system prompt lean avoids
 * burning context on schemas the LLM may never need.
 */
export function formatToolForInstructions(tool: McpToolInfo): string {
	const desc = tool.description?.trim();
	return desc ? `    ${tool.name}: ${desc}` : `    ${tool.name}`;
}

/**
 * Build the instruction block for one MCP server.
 *
 * Lists tool names + descriptions only. The LLM calls
 * mcp(describe="tool_name") to fetch schemas reactively.
 */
export function buildServerInstructions(
	name: string,
	tools: McpToolInfo[],
	hasPrompts: boolean,
	hasResources: boolean,
	serverInstructions: string | undefined,
	slug: string,
): string {
	const parts: string[] = [`MCP server "${name}":`];
	if (tools.length > 0) {
		parts.push(`  Tools (describe=<name> for schema, or call via mcp(server="${name}", tool=<name>, arguments={...})):`);
		for (const t of tools) parts.push(formatToolForInstructions(t));
	}
	if (hasPrompts) parts.push(`  Prompts tool: mcp_${slug}_prompts`);
	if (hasResources) parts.push(`  Resources tool: mcp_${slug}_resources`);
	if (serverInstructions) {
		parts.push(serverInstructions.split("\n").map((l) => "  " + l).join("\n"));
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// MCP capability listing (pagination helpers)
// ---------------------------------------------------------------------------

/**
 * Generic paginator for MCP list endpoints.
 */
async function paginate<T>(
	fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const result = await fetchPage(cursor);
		items.push(...result.items);
		cursor = result.nextCursor;
	} while (cursor !== undefined);
	return items;
}

async function listAllTools(client: Client, signal?: AbortSignal): Promise<McpToolInfo[]> {
	return paginate(
		(cursor) => client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined)
			.then((r) => ({ items: r.tools, nextCursor: r.nextCursor })),
	);
}

async function listAllPrompts(client: Client, signal?: AbortSignal): Promise<Array<{
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
}>> {
	return paginate(
		(cursor) => client.listPrompts(cursor ? { cursor } : undefined, signal ? { signal } : undefined)
			.then((r) => ({ items: r.prompts, nextCursor: r.nextCursor })),
	);
}

async function listAllResources(client: Client, signal?: AbortSignal): Promise<Array<{
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}>> {
	return paginate(
		(cursor) => client.listResources(cursor ? { cursor } : undefined, signal ? { signal } : undefined)
			.then((r) => ({ items: r.resources, nextCursor: r.nextCursor })),
	);
}

async function listAllResourceTemplates(client: Client, signal?: AbortSignal): Promise<Array<{
	uriTemplate: string;
	name: string;
	description?: string;
	mimeType?: string;
}>> {
	return paginate(
		(cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined, signal ? { signal } : undefined)
			.then((r) => ({ items: r.resourceTemplates, nextCursor: r.nextCursor })),
	);
}

// ---------------------------------------------------------------------------
// Prompt tool registration (dispatch style)
// ---------------------------------------------------------------------------

/**
 * Register a single dispatch tool for prompts from an MCP server.
 *
 * The tool accepts `action: "list"` or `action: "get"` and dispatches
 * to the corresponding MCP method.
 */
export async function registerPromptsFromServer(
	client: Client,
	name: string,
	pi: ExtensionAPI,
	notify: NotifyFn,
): Promise<{ tool?: ToolDefinition; hasPrompts: boolean }> {
	const prompts = await listAllPrompts(client);
	const slug = toolSlug(name);
	const toolName = `mcp_${slug}_prompts`;

	if (prompts.length === 0) {
		// Register a minimal placeholder so the tool def replaces any stale version
		// (e.g. when all prompts were removed after initial registration).
		const def: ToolDefinition = {
			name: toolName,
			label: `Prompts (MCP: ${name})`,
			description: `No prompts available from MCP server "${name}".`,
			promptSnippet: `[MCP:${name}] prompts: none`,
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: `No prompts available from MCP server "${name}".` }],
					details: {},
					isError: false,
				};
			},
		};
		pi.registerTool(def);
		return { tool: def, hasPrompts: false };
	}

	const description = [
		`List and execute prompts from MCP server "${name}".`,
		"",
		"Available actions:",
		'- "list" — List all available prompts with names, descriptions, and argument schemas.',
		'- "get" — Retrieve a specific prompt by name with optional arguments. Returns formatted messages.',
		"",
		`Use "list" first to discover prompts, then "get" to retrieve one.`,
	].join("\n");

	const def: ToolDefinition = {
		name: toolName,
		label: `Prompts (MCP: ${name})`,
		description,
		promptSnippet: `[MCP:${name}] prompts: list, get`,
		parameters: Type.Union([
			Type.Object({
				action: Type.Literal("list"),
			}),
			Type.Object({
				action: Type.Literal("get"),
				name: Type.String({ description: "Name of the prompt to retrieve" }),
				arguments: Type.Optional(
					Type.Record(Type.String(), Type.String({
						description: "Prompt argument values (string key-value pairs)",
					})),
				),
			}),
		]),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { action } = params as { action: string };

			try {
				if (action === "list") {
					const promptsNow = await listAllPrompts(client, signal);
					const lines: string[] = [];
					for (const p of promptsNow) {
						lines.push(`Name: ${p.name}`);
						if (p.description) lines.push(`  Description: ${p.description}`);
						if (p.arguments && p.arguments.length > 0) {
							lines.push(`  Arguments:`);
							for (const a of p.arguments) {
								const req = a.required ? " (required)" : "";
								lines.push(`    ${a.name}${req}: ${a.description ?? ""}`);
							}
						}
						lines.push("");
					}
					const text = lines.join("\n").trim() || "No prompts available.";
					return { content: [{ type: "text" as const, text }], details: {}, isError: false };
				}

				if (action === "get") {
					const p = params as { name: string; arguments?: Record<string, unknown> };
					const result = await client.getPrompt(
						{ name: p.name, arguments: p.arguments as Record<string, string> | undefined },
						{ signal },
					);
					const lines: string[] = [];
					if (result.description) {
						lines.push(result.description);
						lines.push("");
					}
					for (const msg of result.messages) {
						const role = msg.role === "assistant" ? "Assistant" : "User";
						const text = msg.content.type === "text"
					? msg.content.text
					: msg.content.type === "image"
						? `[Image: ${msg.content.mimeType}]`
						: msg.content.type === "audio"
							? `[Audio: ${msg.content.mimeType}]`
							: msg.content.type === "resource"
								? resourceToText(msg.content.resource)
								: JSON.stringify(msg.content);
						lines.push(`[${role}]\n${text}\n`);
					}
					return {
						content: [{ type: "text" as const, text: lines.join("\n").trim() }],
						details: {},
						isError: false,
					};
				}

				return {
					content: [{ type: "text", text: `Unknown action: "${action}". Use "list" or "get".` }],
					details: {},
					isError: true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `MCP prompts error: ${message}` }],
					details: {},
					isError: true,
				};
			}
		},
	};

	pi.registerTool(def);
	notify(`MCP: registered prompt tool for "${name}"`, "info");
	return { tool: def, hasPrompts: true };
}

// ---------------------------------------------------------------------------
// Resource tool registration (dispatch style)
// ---------------------------------------------------------------------------

/**
 * Register a single dispatch tool for resources from an MCP server.
 *
 * The tool accepts `action: "list"`, `action: "read"`, or
 * `action: "templates"` and dispatches to the corresponding MCP method.
 */
export async function registerResourcesFromServer(
	client: Client,
	name: string,
	pi: ExtensionAPI,
	notify: NotifyFn,
): Promise<{ tool?: ToolDefinition; hasResources: boolean }> {
	const [resources, templates] = await Promise.all([
		listAllResources(client),
		listAllResourceTemplates(client),
	]);

	const slug = toolSlug(name);
	const toolName = `mcp_${slug}_resources`;

	if (resources.length === 0 && templates.length === 0) {
		// Register a minimal placeholder so the tool def replaces any stale version.
		const def: ToolDefinition = {
			name: toolName,
			label: `Resources (MCP: ${name})`,
			description: `No resources available from MCP server "${name}".`,
			promptSnippet: `[MCP:${name}] resources: none`,
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: `No resources available from MCP server "${name}".` }],
					details: {},
					isError: false,
				};
			},
		};
		pi.registerTool(def);
		return { tool: def, hasResources: false };
	}

	const description = [
		`List, read, and discover resources from MCP server "${name}".`,
		"",
		"Available actions:",
		'- "list" — List all available resources with URIs and descriptions.',
		'- "read" — Read a resource by its URI. Returns text or binary content.',
		'- "templates" — List parameterized resource templates (URIs with {param} placeholders).',
		"",
		'Use "list" or "templates" first to discover resources, then "read" to fetch one.',
	].join("\n");

	const def: ToolDefinition = {
		name: toolName,
		label: `Resources (MCP: ${name})`,
		description,
		promptSnippet: `[MCP:${name}] resources: list, read, templates`,
		parameters: Type.Union([
			Type.Object({
				action: Type.Literal("list"),
			}),
			Type.Object({
				action: Type.Literal("read"),
				uri: Type.String({ description: "URI of the resource to read" }),
			}),
			Type.Object({
				action: Type.Literal("templates"),
			}),
		]),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { action } = params as { action: string };

			try {
				if (action === "list") {
					const resourcesNow = await listAllResources(client, signal);
					const lines: string[] = [];
					for (const r of resourcesNow) {
						lines.push(`URI: ${r.uri}`);
						lines.push(`  Name: ${r.name}`);
						if (r.description) lines.push(`  Description: ${r.description}`);
						if (r.mimeType) lines.push(`  MIME type: ${r.mimeType}`);
						lines.push("");
					}
					const text = lines.join("\n").trim() || "No resources available.";
					return { content: [{ type: "text" as const, text }], details: {}, isError: false };
				}

				if (action === "read") {
					const p = params as { uri: string };
					const result = await client.readResource({ uri: p.uri }, { signal });
					const content = result.contents.map((c) => ({
						type: "text" as const,
						text: resourceToText(c),
					}));
					return { content, details: {}, isError: false };
				}

				if (action === "templates") {
					const templatesNow = await listAllResourceTemplates(client, signal);
					const lines: string[] = [];
					for (const t of templatesNow) {
						lines.push(`URI Template: ${t.uriTemplate}`);
						lines.push(`  Name: ${t.name}`);
						if (t.description) lines.push(`  Description: ${t.description}`);
						if (t.mimeType) lines.push(`  MIME type: ${t.mimeType}`);
						lines.push("");
					}
					const text = lines.join("\n").trim() || "No resource templates available.";
					return { content: [{ type: "text" as const, text }], details: {}, isError: false };
				}

				return {
					content: [{
						type: "text",
						text: `Unknown action: "${action}". Use "list", "read", or "templates".`,
					}],
					details: {},
					isError: true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `MCP resources error: ${message}` }],
					details: {},
					isError: true,
				};
			}
		},
	};

	pi.registerTool(def);
	notify(`MCP: registered resource tool for "${name}"`, "info");
	return { tool: def, hasResources: true };
}

// ---------------------------------------------------------------------------
// Dynamic change notification handlers
// ---------------------------------------------------------------------------

/**
 * Set up a handler for tool list change notifications from an MCP client.
 *
 * On notification, re-lists tools and calls `onChange` with the updated
 * capabilities so the caller can update instructions and status.
 */
/**
 * Payload for tool list changes — only the fields that may have changed.
 */
export interface ToolListUpdate {
	tools: McpToolInfo[];
	serverInstructions: string | undefined;
}

export async function setupToolChangeWatcher(
	client: Client,
	notify: NotifyFn,
	onChange?: (change: ToolListUpdate) => void,
): Promise<void> {
	client.setNotificationHandler("notifications/tools/list_changed", async () => {
		try {
			const tools = await listAllTools(client);
			const serverInstructions = client.getInstructions()?.trim();
			onChange?.({
				tools,
				serverInstructions,
			});
		} catch (err) {
			notify(
				`MCP: tool list change notification error: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});
}

/**
 * Set up a handler for prompt list change notifications from an MCP client.
 *
 * When the server notifies that its prompts changed, re-registers the
 * dispatch tool (replacing the old definition).
 */
export async function setupPromptChangeNotification(
	client: Client,
	name: string,
	pi: ExtensionAPI,
	notify: NotifyFn,
	onChange?: (hasPrompts: boolean) => void,
): Promise<void> {
	client.setNotificationHandler("notifications/prompts/list_changed", async () => {
		try {
			const { hasPrompts } = await registerPromptsFromServer(client, name, pi, notify);
			onChange?.(hasPrompts);
		} catch (err) {
			notify(
				`MCP: failed to re-register prompts for "${name}": ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});
}

/**
 * Set up a handler for resource list change notifications from an MCP client.
 *
 * When the server notifies that its resources changed, re-registers the
 * dispatch tool (replacing the old definition).
 */
export async function setupResourceChangeNotification(
	client: Client,
	name: string,
	pi: ExtensionAPI,
	notify: NotifyFn,
	onChange?: (hasResources: boolean) => void,
): Promise<void> {
	client.setNotificationHandler("notifications/resources/list_changed", async () => {
		try {
			const { hasResources } = await registerResourcesFromServer(client, name, pi, notify);
			onChange?.(hasResources);
		} catch (err) {
			notify(
				`MCP: failed to re-register resources for "${name}": ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});
}
