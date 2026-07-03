/**
 * MCP server config file loading from .mcp.json or .pi/mcp.json.
 *
 * Two formats are supported:
 *
 * OpenCode format (.mcp.json):
 *   { "mcpServers": { "name": { "command": "npx", "args": ["..."], ... } } }
 *
 * pi format (.pi/mcp.json, higher precedence):
 *   { "servers": { "name": { "type": "local", "command": ["npx", "..."], ... } } }
 *
 * The `env` field is passed as environment variables to local servers.
 * The `cwd` field sets the working directory for local servers.
 *
 * Auth: bearer tokens go in `headers` (Authorization: Bearer <token>).
 * OAuth is not supported — see the remote server parser for reasoning.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./types.ts";

type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

function warn(msg: string, notify?: NotifyFn): void {
	if (notify) {
		notify(msg, "warning");
	} else {
		console.warn(msg);
	}
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

function loadOneConfigFile(
	path: string,
	cwd: string,
	notify?: NotifyFn,
): ServerConfig[] | null {
	if (!existsSync(path)) return null;

	let raw: unknown;
	try {
		const content = readFileSync(path, "utf-8");
		raw = JSON.parse(content);
	} catch (err) {
		warn(`MCP config "${path}" could not be read: ${err instanceof SyntaxError ? "invalid JSON" : "read error"}, skipping`, notify);
		return [];
	}

	if (!isRecord(raw)) {
		warn(`MCP config "${path}": must be a JSON object, skipping`, notify);
		return [];
	}

	// Our format: { servers: { name: { type, command, ... } } }
	if ("servers" in raw) {
		const servers = raw.servers;
		if (isRecord(servers)) return parseServers(servers, cwd, path, notify);
		warn(`MCP config "${path}": "servers" must be an object, skipping`, notify);
		return [];
	}

	// OpenCode format: { mcpServers: { name: { command, args, ... } } }
	if ("mcpServers" in raw) {
		const servers = raw.mcpServers;
		if (isRecord(servers)) return parseOpenCodeServers(servers, cwd, path, notify);
		warn(`MCP config "${path}": "mcpServers" must be an object, skipping`, notify);
		return [];
	}

	warn(`MCP config "${path}": missing "servers" or "mcpServers" field, skipping`, notify);
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringRecord(
	value: unknown,
	fieldName: string,
	serverName: string,
	sourcePath: string,
	notify?: NotifyFn,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (isRecord(value) && Object.values(value).every((v) => typeof v === "string")) {
		return value as Record<string, string>;
	}
	warn(
		`MCP config "${serverName}" in ${sourcePath}: "${fieldName}" must be an object with string values, ignoring`,
		notify,
	);
	return undefined;
}

function parseOpenCodeServers(
	servers: Record<string, unknown>,
	cwd: string,
	sourcePath: string,
	notify?: NotifyFn,
): ServerConfig[] {
	const result: ServerConfig[] = [];
	for (const [name, cfg] of Object.entries(servers)) {
		if (!isRecord(cfg)) {
			warn(`MCP config "${name}" in ${sourcePath}: must be an object, skipping`, notify);
			continue;
		}
		const s = cfg;

		// Remote server
		if (typeof s.url === "string" && s.url.length > 0) {
			// Auth: pass bearer tokens via headers (Authorization: Bearer <token>).
			// We deliberately do not implement OAuth — it would require a callback
			// server, browser launch, token storage, and a headless fallback,
			// tripling the codebase for a feature few MCP servers actually need.
			// Bearer tokens cover the vast majority of remote servers (Supabase,
			// DeepSource, Context7, etc.). For OAuth-dependent servers, use
			// pi-mcp-adapter or pi-mcp-extension (both handle the full flow).
			result.push({
				type: "remote",
				url: s.url,
				headers: parseStringRecord(s.headers, "headers", name, sourcePath, notify),
				label: name,
			});
			continue;
		}

		// Local server
		if (typeof s.command === "string" && s.command.length > 0) {
			let args: string[] = [];
			if (Array.isArray(s.args)) {
				if (s.args.every((a) => typeof a === "string")) {
					args = s.args as string[];
				} else {
					warn(`MCP config "${name}" in ${sourcePath}: "args" must be an array of strings, ignoring`, notify);
				}
			}
			result.push({
				type: "local",
				command: [s.command, ...args],
				env: parseStringRecord(s.env, "env", name, sourcePath, notify),
				cwd: typeof s.cwd === "string" ? resolve(cwd, s.cwd) : undefined,
				label: name,
			});
			continue;
		}

		warn(
			`MCP config "${name}" in ${sourcePath}: must have "command" (local) or "url" (remote), skipping`,
			notify,
		);
	}
	return result;
}

function parseServers(
	servers: Record<string, unknown>,
	cwd: string,
	sourcePath: string,
	notify?: NotifyFn,
): ServerConfig[] {
	const result: ServerConfig[] = [];
	for (const [name, cfg] of Object.entries(servers)) {
		if (!isRecord(cfg)) {
			warn(`MCP config "${name}" in ${sourcePath}: must be an object, skipping`, notify);
			continue;
		}
		const s = cfg;
		if (s.type === "remote") {
			if (typeof s.url !== "string" || s.url.length === 0) {
				warn(`MCP config "${name}" in ${sourcePath}: remote server missing "url", skipping`, notify);
				continue;
			}
			result.push({
				type: "remote",
				url: s.url,
				headers: parseStringRecord(s.headers, "headers", name, sourcePath, notify),
				label: typeof s.label === "string" ? s.label : name,
			});
		} else if (s.type === "local") {
			if (!Array.isArray(s.command) || s.command.length === 0 || !s.command.every((c) => typeof c === "string")) {
				warn(`MCP config "${name}" in ${sourcePath}: local server missing or invalid "command" array, skipping`, notify);
				continue;
			}
			result.push({
				type: "local",
				command: s.command as string[],
				env: parseStringRecord(s.env, "env", name, sourcePath, notify),
				cwd: typeof s.cwd === "string" ? resolve(cwd, s.cwd) : undefined,
				label: typeof s.label === "string" ? s.label : name,
			});
		} else {
			warn(
				`MCP config "${name}" in ${sourcePath}: unknown server type "${String(s.type)}", skipping`,
				notify,
			);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveServerConfigs(
	cwd: string,
	notify?: NotifyFn,
): ServerConfig[] {
	const result: ServerConfig[] = [];

	// .mcp.json (OpenCode project format)
	const openCode = loadOneConfigFile(join(cwd, ".mcp.json"), cwd, notify);
	if (openCode) result.push(...openCode);

	// .pi/mcp.json (our format, higher precedence)
	const piConfig = loadOneConfigFile(join(cwd, CONFIG_DIR_NAME, "mcp.json"), cwd, notify);
	if (piConfig) result.push(...piConfig);

	return result;
}
