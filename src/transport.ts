/**
 * Transport creation for MCP client connections.
 *
 * Creates and starts the appropriate transport based on the server config.
 * For remote HTTP(S) servers, attempts Streamable HTTP first, then falls
 * back to HTTP+SSE (spec-compliant backwards compatibility).
 */

import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { jsonSchemaValidator, JsonSchemaValidator } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { ServerConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Errors originating from transport operations.
 */
export class TransportError extends Error {
	declare readonly cause: unknown;

	constructor(
		message: string,
		cause?: unknown,
	) {
		super(message);
		this.cause = cause;
		this.name = "TransportError";
	}
}

/**
 * Result of connecting to an MCP server.
 */
export interface ConnectResult {
	client: Client;
	transport: Transport;
}

/**
 * Wrap a promise with a timeout. Rejects with TransportError on timeout.
 *
 * When the timeout fires, `onTimeout` is called so the caller can abort the
 * underlying operation (e.g. close a transport) to prevent resource leaks.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new TransportError(`Connection to "${label}" timed out after ${ms}ms`));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Connect to an MCP server using the appropriate transport.
 *
 * - Local (stdio): spawns a child process.
 * - Remote (HTTP/HTTPS): tries Streamable HTTP first; if that fails during
 *   handshake, falls back to HTTP+SSE (spec-compliant backwards compat).
 */
export async function connectToServerWithVersion(
	config: ServerConfig,
	label: string,
	version: string,
): Promise<ConnectResult> {
	if (config.type === "local") {
		return connectStdio(config, label, version);
	}
	return connectRemote(config, label, version);
}

// ---------------------------------------------------------------------------
// Utility: no-op JSON Schema validator for Client constructor.
// Avoids loading ajv + ajv-formats (~3.7M) which we never use for tool
// output validation.
// ---------------------------------------------------------------------------

const noopJsonValidator: jsonSchemaValidator = {
	getValidator<T>(): JsonSchemaValidator<T> {
		return (input: unknown) => ({
			valid: true as const,
			data: input as T,
			errorMessage: undefined,
		});
	},
};

// ---------------------------------------------------------------------------
// Connect helper — creates a Client, attaches to transport, and waits for
// the initialize handshake with a timeout.
// ---------------------------------------------------------------------------

async function connectClient(
	transport: Transport,
	version: string,
	label: string,
): Promise<Client> {
	const client = new Client(
		{ name: "pi", version },
		{ capabilities: {}, jsonSchemaValidator: noopJsonValidator },
	);

	const connect = client.connect(transport);
	// Suppress rejection if timeout wins first — closing the transport will
	// abort the in-flight connect and we don't want an unhandled rejection.
	const suppressed = connect.catch(() => {});

	try {
		await withTimeout(connect, CONNECT_TIMEOUT_MS, label);
		return client;
	} catch (err) {
		await transport.close().catch(() => {});
		await suppressed; // Wait for suppressed promise to settle before throwing
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Local (stdio)
// ---------------------------------------------------------------------------

async function connectStdio(config: ServerConfig & { type: "local" }, label: string, version: string): Promise<ConnectResult> {

	const baseEnv: Record<string, string> = {};
	for (const key of Object.keys(process.env)) {
		const val = process.env[key];
		if (val !== undefined) baseEnv[key] = val;
	}
	const env: Record<string, string> = config.env
		? { ...baseEnv, ...config.env }
		: baseEnv;

	const transport = new StdioClientTransport({
		command: config.command[0],
		args: config.command.slice(1),
		cwd: config.cwd,
		env,
	});

	try {
		const client = await connectClient(transport, version, label);
		return { client, transport };
	} catch (err) {
		throw new TransportError(`Failed to connect to local MCP server "${label}"`, err);
	}
}

// ---------------------------------------------------------------------------
// Remote (Streamable HTTP → SSE fallback)
// ---------------------------------------------------------------------------

async function connectRemote(config: ServerConfig & { type: "remote" }, label: string, version: string): Promise<ConnectResult> {

	const url = new URL(config.url);
	const requestInit = config.headers ? { headers: config.headers } : undefined;

	// Attempt 1: Streamable HTTP (MCP spec 2025-11-25+)
	try {
		const transport = new StreamableHTTPClientTransport(url, {
			requestInit,
		});
		const client = await connectClient(transport, version, label);
		return { client, transport };
	} catch (streamableErr) {
		// Attempt 2: Fall back to HTTP+SSE (older protocol)
		try {
			const transport = new SSEClientTransport(url, {
				requestInit,
			});
			const client = await connectClient(transport, version, label);
			return { client, transport };
		} catch (sseErr) {
			throw new TransportError(
				`Failed to connect to remote MCP server "${label}": ` +
				`Streamable HTTP: ${streamableErr instanceof Error ? streamableErr.message : String(streamableErr)}; ` +
				`SSE fallback: ${sseErr instanceof Error ? sseErr.message : String(sseErr)}`,
			);
		}
	}
}
