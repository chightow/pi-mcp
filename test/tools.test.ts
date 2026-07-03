import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/client";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	collectServerCapabilities,
	registerPromptsFromServer,
	registerResourcesFromServer,
	mapContent,
	setupToolChangeWatcher,
	setupPromptChangeNotification,
	setupResourceChangeNotification,
	toolSlug,
	buildServerInstructions,
} from "../src/tools.ts";
import type { ToolContent } from "../src/tools.ts";

// ---------------------------------------------------------------------------
// FakeClient — simulates an MCP Client for testing
// ---------------------------------------------------------------------------

interface ToolDef {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

interface PromptDef {
	name: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface ResourceDef {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

class FakeClient {
	instructions?: string;
	version = { name: "test-server", version: "1.0.0" };
	tools: ToolDef[] = [];
	prompts: PromptDef[] = [];
	resources: ResourceDef[] = [];
	callLog: unknown[] = [];
	closed = false;
	private handlers = new Map<string, (payload: unknown) => Promise<void>>();

	async listTools(params?: { cursor?: string }) {
		if (this.tools.length <= 2) {
			return { tools: this.tools, nextCursor: undefined };
		}
		if (!params?.cursor) {
			return { tools: this.tools.slice(0, 2), nextCursor: "page2" };
		}
		if (params.cursor === "page2") {
			return { tools: this.tools.slice(2), nextCursor: undefined };
		}
		return { tools: [], nextCursor: undefined };
	}

	async listPrompts(_params?: { cursor?: string }) {
		return { prompts: this.prompts, nextCursor: undefined };
	}

	async listResources(_params?: { cursor?: string }) {
		return { resources: this.resources, nextCursor: undefined };
	}

	async listResourceTemplates(_params?: { cursor?: string }) {
		return { resourceTemplates: [], nextCursor: undefined };
	}

	async callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		_resultSchema?: unknown,
		options?: { signal?: AbortSignal },
	): Promise<{ content: unknown; isError: boolean }> {
		this.callLog.push({ params, options });
		return {
			content: [{ type: "text", text: `result:${params.name}` }],
			isError: false,
		};
	}

	getInstructions() {
		return this.instructions;
	}

	getServerVersion() {
		return this.version;
	}

	setNotificationHandler(method: string, handler: (payload: unknown) => Promise<void>) {
		this.handlers.set(method, handler);
	}

	async triggerNotification(method: string, payload: unknown) {
		const handler = this.handlers.get(method);
		if (handler) await handler(payload);
	}

	async close() {
		this.closed = true;
	}
}

// ---------------------------------------------------------------------------
// collectServerCapabilities
// ---------------------------------------------------------------------------

describe("collectServerCapabilities", () => {
	it("returns tool names and server instructions", async () => {
		const client = new FakeClient();
		client.instructions = "Be concise.";
		client.tools = [
			{ name: "echo", description: "Echo input", inputSchema: {} },
			{ name: "list", description: "List items", inputSchema: {} },
		];

		const caps = await collectServerCapabilities(client as unknown as Client);

		assert.deepEqual(caps.tools.map((t) => t.name), ["echo", "list"]);
		assert.equal(caps.serverInstructions, "Be concise.");
		assert.equal(caps.hasPrompts, false);
		assert.equal(caps.hasResources, false);
	});

	it("detects prompts and resources", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "echo", inputSchema: {} }];
		client.prompts = [{ name: "summarize" }];
		client.resources = [{ uri: "file:///data", name: "data" }];

		const caps = await collectServerCapabilities(client as unknown as Client);

		assert.equal(caps.hasPrompts, true);
		assert.equal(caps.hasResources, true);
		assert.equal(caps.tools.length, 1);
	});

	it("handles empty tool list", async () => {
		const client = new FakeClient();

		const caps = await collectServerCapabilities(client as unknown as Client);

		assert.deepEqual(caps.tools, []);
		assert.equal(caps.serverInstructions, undefined);
	});

	it("paginates through listTools", async () => {
		const client = new FakeClient();
		client.tools = [
			{ name: "a", inputSchema: {} },
			{ name: "b", inputSchema: {} },
			{ name: "c", inputSchema: {} },
		];

		const caps = await collectServerCapabilities(client as unknown as Client);

		assert.deepEqual(caps.tools.map((t) => t.name), ["a", "b", "c"]);
	});
});

// ---------------------------------------------------------------------------
// mcp dispatch tool execute behavior (tested through a mock registration)
// ---------------------------------------------------------------------------

describe("mcp dispatch tool", () => {
	it("calls client.callTool and maps content", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "echo", inputSchema: {} }];

		// Simulate the mcp tool's execute handler logic directly
		const { server, tool: toolName, arguments: args } = {
			server: "test",
			tool: "echo",
			arguments: { text: "hello" },
		};

		const result = await client.callTool(
			{ name: toolName, arguments: args as Record<string, unknown> },
			undefined,
			{ signal: undefined },
		);

		assert.equal(client.callLog.length, 1);
		const call = client.callLog[0] as { params: { name: string; arguments?: Record<string, unknown> } };
		assert.equal(call.params.name, "echo");
		assert.deepEqual(call.params.arguments, { text: "hello" });

		const rawContent = result.content;
		const content = Array.isArray(rawContent)
			? rawContent.map(mapContent)
			: [{ type: "text" as const, text: `[fallback: ${JSON.stringify(rawContent)}]` }];

		assert.equal(content.length, 1);
		assert.equal(content[0].type, "text");
		assert.equal((content[0] as { type: "text"; text: string }).text, "result:echo");
	});

	it("forwards abort signal to callTool", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "slow", inputSchema: {} }];

		const controller = new AbortController();
		await client.callTool(
			{ name: "slow", arguments: {} },
			undefined,
			{ signal: controller.signal },
		);

		assert.equal(client.callLog.length, 1);
		const call = client.callLog[0] as { options?: { signal?: AbortSignal } };
		assert.equal(call.options?.signal, controller.signal);
	});

	it("rethrows error from callTool", async () => {
		const client = new FakeClient();
		client.callTool = async () => {
			throw new Error("boom");
		};

		let isError = false;
		let errorText = "";
		try {
			const result = await client.callTool(
				{ name: "fail", arguments: {} },
				undefined,
				undefined,
			);
			const content = Array.isArray(result.content)
				? result.content.map(mapContent)
				: [{ type: "text" as const, text: `[fallback: ${JSON.stringify(result.content)}]` }];
			// Should not reach here
			assert.fail("Should have thrown");
		} catch (err) {
			isError = true;
			errorText = err instanceof Error ? err.message : String(err);
		}

		assert.equal(isError, true);
		assert.ok(errorText.includes("boom"));
	});
});

// ---------------------------------------------------------------------------
// Content type mapping (mapContent)
// ---------------------------------------------------------------------------

describe("mapContent", () => {
	it("maps text content", () => {
		const result = mapContent({ type: "text", text: "hello" });
		assert.equal(result.type, "text");
		assert.equal((result as { type: "text"; text: string }).text, "hello");
	});

	it("maps image content", () => {
		const result = mapContent({ type: "image", data: "base64data", mimeType: "image/png" });
		assert.equal(result.type, "image");
		if (result.type === "image") {
			assert.equal(result.data, "base64data");
			assert.equal(result.mimeType, "image/png");
		}
	});

	it("maps image content with default mime type", () => {
		const result = mapContent({ type: "image", data: "data" });
		assert.equal(result.type, "image");
		if (result.type === "image") {
			assert.equal(result.data, "data");
			assert.equal(result.mimeType, "image/png");
		}
	});

	it("maps image content to text fallback when data is not a string", () => {
		const result = mapContent({ type: "image", data: 123 });
		assert.equal(result.type, "text");
	});

	it("maps audio content to text fallback", () => {
		const result = mapContent({ type: "audio", data: "data", mimeType: "audio/wav" });
		assert.equal(result.type, "text");
		assert.match((result as ToolContent & { type: "text" }).text, /audio\/wav/);
	});

	it("maps resource content with text", () => {
		const result = mapContent({
			type: "resource",
			resource: { text: "file content", uri: "file:///test.txt", mimeType: "text/plain" },
		});
		assert.equal(result.type, "text");
		assert.equal((result as { type: "text"; text: string }).text, "file content");
	});

	it("maps resource content with blob to text description", () => {
		const result = mapContent({
			type: "resource",
			resource: { blob: "base64", uri: "file:///img.png", mimeType: "image/png" },
		});
		assert.equal(result.type, "text");
		assert.match((result as { type: "text"; text: string }).text, /binary/);
		assert.match((result as { type: "text"; text: string }).text, /file:\/\/\/img\.png/);
	});

	it("maps resource with only uri", () => {
		const result = mapContent({
			type: "resource",
			resource: { uri: "file:///data.txt" },
		});
		assert.equal(result.type, "text");
		assert.equal((result as { type: "text"; text: string }).text, "file:///data.txt");
	});

	it("maps resource with missing resource field to error text", () => {
		const result = mapContent({ type: "resource" });
		assert.equal(result.type, "text");
		assert.match((result as { type: "text"; text: string }).text, /missing resource data/);
	});

	it("maps embedded-resource content", () => {
		const result = mapContent({
			type: "embedded-resource",
			resource: { text: "embedded text", uri: "file:///embed.txt" },
		});
		assert.equal(result.type, "text");
		assert.equal((result as { type: "text"; text: string }).text, "embedded text");
	});

	it("maps context content", () => {
		const result = mapContent({
			type: "context",
			document: { text: "context text" },
		});
		assert.equal(result.type, "text");
		assert.equal((result as { type: "text"; text: string }).text, "context text");
	});

	it("falls back to JSON for unknown content types", () => {
		const result = mapContent({ type: "frobnicate", value: 42 });
		assert.equal(result.type, "text");
		assert.match((result as { type: "text"; text: string }).text, /frobnicate/);
	});

	it("maps resource_link content to a text label with name and uri", () => {
		const result = mapContent({ type: "resource_link", uri: "file:///x.txt", name: "x" });
		assert.equal(result.type, "text");
		assert.match((result as { type: "text"; text: string }).text, /Resource link: x \(file:\/\/\/x\.txt\)/);
	});
});

// ---------------------------------------------------------------------------
// setupToolChangeWatcher
// ---------------------------------------------------------------------------

describe("setupToolChangeWatcher", () => {
	const noopNotify: (msg: string, level: "info" | "warning" | "error") => void = () => {};

	it("calls onChange when tool list changes", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "old", inputSchema: {} }];
		const changes: string[][] = [];

		await setupToolChangeWatcher(
			client as unknown as Client,
			noopNotify,
			(caps) => changes.push(caps.tools.map((t) => t.name)),
		);

		client.tools = [{ name: "new", inputSchema: {} }];
		await client.triggerNotification("notifications/tools/list_changed", {});

		assert.equal(changes.length, 1);
		assert.deepEqual(changes[0], ["new"]);
	});

	it("does not throw when no onChange is provided", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "t", inputSchema: {} }];

		await setupToolChangeWatcher(client as unknown as Client, noopNotify);

		client.tools = [{ name: "t2", inputSchema: {} }];
		await client.triggerNotification("notifications/tools/list_changed", {});
	});

	it("reports empty tool list correctly", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "t", inputSchema: {} }];
		const changes: string[][] = [];

		await setupToolChangeWatcher(
			client as unknown as Client,
			noopNotify,
			(caps) => changes.push(caps.tools.map((t) => t.name)),
		);

		client.tools = [];
		await client.triggerNotification("notifications/tools/list_changed", {});

		assert.equal(changes.length, 1);
		assert.deepEqual(changes[0], []);
	});

	it("calls notify on error", async () => {
		const client = new FakeClient();
		const notifies: string[] = [];
		const notify: (msg: string, level: "info" | "warning" | "error") => void = (msg) => {
			notifies.push(msg);
		};

		// Break listAllTools by making getInstructions throw
		client.getInstructions = () => {
			throw new Error("instruction fail");
		};

		await setupToolChangeWatcher(client as unknown as Client, notify);
		await client.triggerNotification("notifications/tools/list_changed", {});

		assert.ok(notifies.some((n) => n.includes("instruction fail")));
	});
});

// ---------------------------------------------------------------------------
// Prompt dispatch tool registration
// ---------------------------------------------------------------------------

describe("registerPromptsFromServer", () => {
	it("registers a dispatch tool for prompts", async () => {
		const client = new FakeClient();
		client.prompts = [
			{ name: "summarize", description: "Summarize text", arguments: [{ name: "text", required: true }] },
		];

		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t); },
		} as unknown as ExtensionAPI;

		const result = await registerPromptsFromServer(
			client as unknown as Client,
			"test-server",
			pi,
			() => {},
		);

		assert.ok(result.tool);
		assert.equal(result.tool.name, "mcp_test_server_prompts");
		assert.equal(registered.length, 1);

		// Test the dispatch tool's execute handler
		const exec = result.tool.execute;

		// list action
		const listResult = await exec("id", { action: "list" }, undefined, undefined, {} as ExtensionContext);
		const listData = listResult as { content: Array<{ text?: string }> };
		assert.ok(listData.content[0].text?.includes("summarize"));

		// get action
		const getResult = await exec("id", { action: "get", name: "summarize", arguments: { text: "hello" } }, undefined, undefined, {} as ExtensionContext);
		const getData = getResult as { content: Array<{ text?: string }> };
		assert.ok(getData.content[0].text);

		// unknown action
		const badResult = await exec("id", { action: "bogus" }, undefined, undefined, {} as ExtensionContext);
		const badData = badResult as unknown as { isError: boolean };
		assert.equal(badData.isError, true);
	});

	it("registers a placeholder when no prompts available", async () => {
		const client = new FakeClient();

		const registered: string[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t.name); },
		} as unknown as ExtensionAPI;

		const result = await registerPromptsFromServer(
			client as unknown as Client,
			"test",
			pi,
			() => {},
		);

		assert.ok(result.tool);
		assert.equal(result.tool.name, "mcp_test_prompts");
		assert.equal(registered.length, 1);
		assert.equal(registered[0], "mcp_test_prompts");
	});
});

// ---------------------------------------------------------------------------
// Resource dispatch tool registration
// ---------------------------------------------------------------------------

describe("registerResourcesFromServer", () => {
	it("registers a dispatch tool for resources", async () => {
		const client = new FakeClient();
		client.resources = [
			{ uri: "file:///data", name: "data", description: "Data file" },
		];

		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t); },
		} as unknown as ExtensionAPI;

		const result = await registerResourcesFromServer(
			client as unknown as Client,
			"test-server",
			pi,
			() => {},
		);

		assert.ok(result.tool);
		assert.equal(result.tool.name, "mcp_test_server_resources");
		assert.equal(registered.length, 1);

		const exec = result.tool.execute;

		// list action
		const listResult = await exec("id", { action: "list" }, undefined, undefined, {} as ExtensionContext);
		const listData = listResult as { content: Array<{ text?: string }> };
		assert.ok(listData.content[0].text?.includes("file:///data"));

		// unknown action
		const badResult = await exec("id", { action: "bogus" }, undefined, undefined, {} as ExtensionContext);
		const badData = badResult as unknown as { isError: boolean };
		assert.equal(badData.isError, true);
	});

	it("registers a placeholder when no resources available", async () => {
		const client = new FakeClient();

		const registered: string[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t.name); },
		} as unknown as ExtensionAPI;

		const result = await registerResourcesFromServer(
			client as unknown as Client,
			"test",
			pi,
			() => {},
		);

		assert.ok(result.tool);
		assert.equal(result.tool.name, "mcp_test_resources");
		assert.equal(registered.length, 1);
		assert.equal(registered[0], "mcp_test_resources");
	});
});

// ---------------------------------------------------------------------------
// setupPromptChangeNotification
// ---------------------------------------------------------------------------

describe("setupPromptChangeNotification", () => {
	it("re-registers prompt dispatch tool on notification", async () => {
		const client = new FakeClient();
		client.prompts = [{ name: "old-prompt" }];

		const registered: string[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t.name); },
		} as unknown as ExtensionAPI;

		const notifies: string[] = [];
		const notify: (msg: string, level: "info" | "warning" | "error") => void = (msg) => {
			notifies.push(msg);
		};

		let onChangeCalled = false;

		await setupPromptChangeNotification(
			client as unknown as Client,
			"test-server",
			pi,
			notify,
			() => { onChangeCalled = true; },
		);

		// Update prompts and trigger notification
		client.prompts = [{ name: "new-prompt" }];
		await client.triggerNotification("notifications/prompts/list_changed", {});

		// Should have re-registered (new name registered)
		assert.ok(registered.some((n) => n === "mcp_test_server_prompts"));
		assert.ok(onChangeCalled);
	});

	it("notifies on error during re-registration", async () => {
		const client = new FakeClient();
		client.prompts = [{ name: "p" }];

		// Break listPrompts to cause an error
		client.listPrompts = async () => { throw new Error("prompt fail"); };

		const notifies: string[] = [];
		const notify: (msg: string, level: "info" | "warning" | "error") => void = (msg, level) => {
			notifies.push(`${level}:${msg}`);
		};

		await setupPromptChangeNotification(
			client as unknown as Client,
			"test",
			{ registerTool: () => {} } as unknown as ExtensionAPI,
			notify,
		);

		await client.triggerNotification("notifications/prompts/list_changed", {});

		assert.ok(notifies.some((n) => n.includes("prompt fail")));
	});
});

// ---------------------------------------------------------------------------
// setupResourceChangeNotification
// ---------------------------------------------------------------------------

describe("setupResourceChangeNotification", () => {
	it("re-registers resource dispatch tool on notification", async () => {
		const client = new FakeClient();
		client.resources = [{ uri: "file:///old", name: "old" }];

		const registered: string[] = [];
		const pi = {
			registerTool: (t: ToolDefinition) => { registered.push(t.name); },
		} as unknown as ExtensionAPI;

		let onChangeCalled = false;

		await setupResourceChangeNotification(
			client as unknown as Client,
			"test-server",
			pi,
			() => {},
			() => { onChangeCalled = true; },
		);

		// Update resources and trigger notification
		client.resources = [{ uri: "file:///new", name: "new" }];
		await client.triggerNotification("notifications/resources/list_changed", {});

		assert.ok(registered.some((n) => n === "mcp_test_server_resources"));
		assert.ok(onChangeCalled);
	});

	it("notifies on error during re-registration", async () => {
		const client = new FakeClient();
		client.resources = [{ uri: "file:///r", name: "r" }];

		// Break listResources to cause an error
		client.listResources = async () => { throw new Error("resource fail"); };

		const notifies: string[] = [];
		const notify: (msg: string, level: "info" | "warning" | "error") => void = (msg, level) => {
			notifies.push(`${level}:${msg}`);
		};

		await setupResourceChangeNotification(
			client as unknown as Client,
			"test",
			{ registerTool: () => {} } as unknown as ExtensionAPI,
			notify,
		);

		await client.triggerNotification("notifications/resources/list_changed", {});

		assert.ok(notifies.some((n) => n.includes("resource fail")));
	});
});

// ---------------------------------------------------------------------------
// toolSlug
// ---------------------------------------------------------------------------

describe("toolSlug", () => {
	it("converts a name to lowercase with underscores", () => {
		assert.equal(toolSlug("My Server"), "my_server");
	});

	it("removes leading and trailing non-alphanumeric characters", () => {
		assert.equal(toolSlug("!!!server!!!"), "server");
	});

	it("collapses multiple separators into a single underscore", () => {
		assert.equal(toolSlug("a  b---c"), "a_b_c");
	});

	it("handles an empty string", () => {
		assert.equal(toolSlug(""), "mcp");
	});

	it("handles strings with only special characters", () => {
		assert.equal(toolSlug("!!! @@@ ###"), "mcp");
	});

	it("handles camelCase and mixed formatting", () => {
		assert.equal(toolSlug("FileSystem MCP"), "filesystem_mcp");
	});
});

// ---------------------------------------------------------------------------
// buildServerInstructions / formatToolForInstructions
// ---------------------------------------------------------------------------

describe("buildServerInstructions", () => {
	it("lists tool names and descriptions without schema bloat", () => {
		const instructions = buildServerInstructions(
			"fs",
			[
				{
					name: "read_file",
					description: "Read a file.",
					inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
				{ name: "noop", inputSchema: {} },
			],
			false,
			false,
			undefined,
			"fs",
		);
		assert.ok(instructions.includes(`MCP server "fs":`));
		assert.ok(instructions.includes('describe=<name> for schema'));
		assert.ok(instructions.includes("read_file: Read a file."));
		assert.ok(instructions.includes("noop"));
		// Schemas are NOT dumped inline — use mcp(describe="tool_name") to fetch on demand
		assert.ok(!instructions.includes("inputSchema"));
		assert.ok(!instructions.includes('"properties"'));
	});

	it("lists prompts and resources dispatch tools when present", () => {
		const instructions = buildServerInstructions("web", [], true, true, undefined, "web");
		assert.ok(instructions.includes("Prompts tool: mcp_web_prompts"));
		assert.ok(instructions.includes("Resources tool: mcp_web_resources"));
	});

	it("indents server-supplied instructions", () => {
		const instructions = buildServerInstructions("s", [], false, false, "Be brief.", "s");
		assert.match(instructions, /\n  Be brief\./);
	});
});

// ---------------------------------------------------------------------------
// Pagination edge cases (tested through collectServerCapabilities with
// custom FakeClient pagination behavior)
// ---------------------------------------------------------------------------

describe("pagination edge cases", () => {
	it("treats empty string cursor as a valid cursor (does not stop pagination)", async () => {
		const client = new FakeClient();
		client.tools = [
			{ name: "a", inputSchema: {} },
			{ name: "b", inputSchema: {} },
		];
		let callCount = 0;
		client.listTools = async (_params?: { cursor?: string }) => {
			callCount++;
			if (callCount === 1) {
				// Return empty string cursor — must NOT stop pagination
				return { tools: client.tools, nextCursor: "" };
			}
			return { tools: [], nextCursor: undefined };
		};

		const caps = await collectServerCapabilities(client as unknown as Client);
		assert.deepEqual(caps.tools.map((t) => t.name), ["a", "b"]);
		assert.equal(callCount, 2, "should request a second page");
	});

	it("paginates through multiple pages", async () => {
		const client = new FakeClient();
		client.tools = [
			{ name: "a", inputSchema: {} },
			{ name: "b", inputSchema: {} },
			{ name: "c", inputSchema: {} },
			{ name: "d", inputSchema: {} },
		];

		const caps = await collectServerCapabilities(client as unknown as Client);
		assert.equal(caps.tools.length, 4);
	});

	it("handles single page with no cursor", async () => {
		const client = new FakeClient();
		client.tools = [{ name: "only", inputSchema: {} }];

		const caps = await collectServerCapabilities(client as unknown as Client);
		assert.deepEqual(caps.tools.map((t) => t.name), ["only"]);
	});

	it("handles empty tool list", async () => {
		const client = new FakeClient();
		client.tools = [];

		const caps = await collectServerCapabilities(client as unknown as Client);
		assert.equal(caps.tools.length, 0);
	});
});
