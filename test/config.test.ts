import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerConfigs } from "../src/config.ts";

describe("resolveServerConfigs", () => {
	let warns: string[] = [];
	const originalWarn = console.warn;

	beforeEach(() => {
		warns = [];
		console.warn = (...args: unknown[]) => {
			warns.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.warn = originalWarn;
	});

	function makeProject(config?: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
		if (config !== undefined) {
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify(config));
		}
		return dir;
	}

	it("returns an empty array when no config file exists", () => {
		const dir = makeProject();
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.equal(warns.length, 0);
	});

	it("parses local and remote servers", () => {
		const dir = makeProject({
			servers: {
				fs: {
					type: "local",
					command: ["npx", "@modelcontextprotocol/server-filesystem", "/tmp"],
					env: { FOO: "bar" },
					cwd: "relative",
				},
				web: {
					type: "remote",
					url: "https://example.com/mcp",
					headers: { Authorization: "token" },
				},
			},
		});
		const configs = resolveServerConfigs(dir);
		assert.equal(configs.length, 2);

		const local = configs.find((c) => c.type === "local");
		const remote = configs.find((c) => c.type === "remote");

		assert.deepEqual(local, {
			type: "local",
			command: ["npx", "@modelcontextprotocol/server-filesystem", "/tmp"],
			env: { FOO: "bar" },
			cwd: join(dir, "relative"),
			label: "fs",
		});
		assert.deepEqual(remote, {
			type: "remote",
			url: "https://example.com/mcp",
			headers: { Authorization: "token" },
			label: "web",
		});
	});

	it("warns and returns empty for invalid JSON", () => {
		const dir = makeProject();
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "mcp.json"), "not json");
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.ok(warns.some((w) => w.includes("invalid JSON")));
	});

	it("warns when the servers field is missing", () => {
		const dir = makeProject({ other: true });
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.ok(warns.some((w) => w.includes("missing \"servers\" or \"mcpServers\"")));
	});

	it("warns and skips unknown server types", () => {
		const dir = makeProject({
			servers: {
				ws: { type: "websocket", url: "wss://example.com" },
			},
		});
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.ok(warns.some((w) => w.includes('unknown server type "websocket"')));
	});

	it("warns and skips local servers with invalid commands", () => {
		const dir = makeProject({
			servers: {
				bad1: { type: "local", command: [] },
				bad2: { type: "local", command: [1, 2] },
			},
		});
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.equal(warns.filter((w) => w.includes("invalid \"command\"")).length, 2);
	});

	it("warns and skips remote servers missing a url", () => {
		const dir = makeProject({
			servers: {
				bad: { type: "remote" },
			},
		});
		assert.deepEqual(resolveServerConfigs(dir), []);
		assert.ok(warns.some((w) => w.includes("missing \"url\"")));
	});

	it("parses OpenCode format from .mcp.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fs: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						env: { FOO: "bar" },
						cwd: "relative",
					},
					web: {
						url: "https://example.com/mcp",
						headers: { Authorization: "token" },
					},
				},
			}),
		);
		const configs = resolveServerConfigs(dir);
		assert.equal(configs.length, 2);

		const local = configs.find((c) => c.type === "local");
		const remote = configs.find((c) => c.type === "remote");

		assert.deepEqual(local, {
			type: "local",
			command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			env: { FOO: "bar" },
			cwd: join(dir, "relative"),
			label: "fs",
		});
		assert.deepEqual(remote, {
			type: "remote",
			url: "https://example.com/mcp",
			headers: { Authorization: "token" },
			label: "web",
		});
	});

	it("prefers .pi/mcp.json over .mcp.json when both exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { srv: { command: "default", args: [] } } }),
		);
		mkdirSync(join(dir, ".pi"));
		writeFileSync(
			join(dir, ".pi", "mcp.json"),
			JSON.stringify({ servers: { srv: { type: "local", command: ["override"] } } }),
		);
		// Both configs appear in the array; .pi/mcp.json is loaded second
		// so the caller sees the override when processing sequentially.
		const configs = resolveServerConfigs(dir);
		assert.equal(configs.length, 2);
		const srv = configs[1];
		assert.equal(srv.type, "local");
		if (srv.type === "local") {
			assert.deepEqual(srv.command, ["override"]);
		}
	});
});
