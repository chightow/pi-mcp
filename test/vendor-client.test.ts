/**
 * Integration test for Client + Protocol via in-memory transport.
 *
 * Exercises the real SDK Client through a minimal MCP handshake,
 * ensuring our import paths and usage patterns work. Catches
 * regressions if the SDK protocol handling changes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";

// ---------------------------------------------------------------------------
// In-memory loopback "server" transport
// ---------------------------------------------------------------------------

class FakeServerTransport implements Transport {
	private _onclose: (() => void) | undefined;
	private _onerror: ((error: Error) => void) | undefined;
	private _onmessage: ((message: unknown, extra?: unknown) => void) | undefined;

	get onclose(): (() => void) | undefined { return this._onclose; }
	set onclose(v: (() => void) | undefined) { this._onclose = v; }

	get onerror(): ((error: Error) => void) | undefined { return this._onerror; }
	set onerror(v: ((error: Error) => void) | undefined) { this._onerror = v; }

	get onmessage(): ((message: unknown, extra?: unknown) => void) | undefined { return this._onmessage; }
	set onmessage(v: ((message: unknown, extra?: unknown) => void) | undefined) { this._onmessage = v; }

	send(message: unknown, _options?: unknown): Promise<void> {
		const msg = message as Record<string, unknown>;
		const method = msg.method as string | undefined;
		const id = msg.id;

		if (id === undefined) return Promise.resolve(); // notification

		const respond = (result: unknown) => {
			this._onmessage?.({ jsonrpc: "2.0", id, result });
		};
		const respondError = (code: number, text: string) => {
			this._onmessage?.({ jsonrpc: "2.0", id, error: { code, message: text } });
		};

		switch (method) {
			case "initialize":
				respond({
					protocolVersion: "2025-11-25",
					capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
					serverInfo: { name: "test-server", version: "1.0.0" },
					instructions: "Be concise.",
				});
				break;
			case "tools/list":
				respond({
					tools: [{
						name: "echo",
						description: "Echo back the input",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					}],
				});
				break;
			case "tools/call": {
				const params = msg.params as Record<string, unknown> | undefined;
				if (params?.name === "echo") {
					respond({ content: [{ type: "text", text: "echod" }], isError: false });
				} else {
					respondError(-32601, `Unknown tool: ${String(params?.name)}`);
				}
				break;
			}
			case "ping":
				respond({});
				break;
			default:
				respondError(-32601, `Method not found: ${method}`);
		}
		return Promise.resolve();
	}

	start(): Promise<void> { return Promise.resolve(); }
	close(): Promise<void> { return Promise.resolve(); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Client over in-memory transport", () => {
	it("connects and completes initialization", async () => {
		const client = new Client({ name: "pi-test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(new FakeServerTransport());

		const caps = client.getServerCapabilities();
		assert.ok(caps);
		assert.ok(caps.tools?.listChanged);

		const info = client.getServerVersion();
		assert.equal(info?.name, "test-server");
		assert.equal(info?.version, "1.0.0");

		assert.equal(client.getInstructions(), "Be concise.");
	});

	it("lists tools after connection", async () => {
		const client = new Client({ name: "pi-test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(new FakeServerTransport());

		const result = await client.listTools();
		assert.equal(result.tools.length, 1);
		assert.equal(result.tools[0].name, "echo");
	});

	it("calls a tool and returns the result", async () => {
		const client = new Client({ name: "pi-test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(new FakeServerTransport());

		const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
		assert.equal(result.isError, false);
		const content = result.content as Array<Record<string, unknown>>;
		assert.equal(content[0].text, "echod");
	});

	it("pings the server", async () => {
		const client = new Client({ name: "pi-test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(new FakeServerTransport());

		const result = await client.ping();
		assert.ok(result); // EmptyResultSchema — should not throw
	});

	it("rejects connection on unsupported protocol version", async () => {
		let savedOnmessage: ((message: unknown, extra?: unknown) => void) | undefined;

		class BadVersionTransport implements Transport {
			onclose: (() => void) | undefined;
			onerror: ((error: Error) => void) | undefined;
			onmessage: ((message: unknown, extra?: unknown) => void) | undefined;

			send(message: unknown): Promise<void> {
				const msg = message as Record<string, unknown>;
				savedOnmessage = this.onmessage;
				this.onmessage?.({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2099-01-01",
						capabilities: {},
						serverInfo: { name: "old", version: "0.1" },
					},
				});
				return Promise.resolve();
			}
			start(): Promise<void> { return Promise.resolve(); }
			close(): Promise<void> { return Promise.resolve(); }
		}

		const client = new Client({ name: "pi-test", version: "1.0.0" }, { capabilities: {} });
		await assert.rejects(
			() => client.connect(new BadVersionTransport()),
			{ message: /protocol version is not supported/ },
		);
	});
});
