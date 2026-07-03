# pi-mcp

Single-tool MCP client extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

One `mcp` dispatch tool instead of hundreds of individual tool registrations.
Lean system prompt — pay for tool schemas only when you use them.

## Install

```bash
git clone https://github.com/chightow/pi-mcp.git
cd pi-mcp
npm install --ignore-scripts
```

Then start pi with the extension flag:

```bash
pi -e /path/to/pi-mcp
```

Create a `.mcp.json` or `.pi/mcp.json` in your project root to configure
servers.

## Usage

```
# Call a tool
mcp(server="fs", tool="read_file", arguments={path: "/tmp/foo"})

# Discover tools
mcp(search="screenshot")         → finds matching tools across all servers
mcp(describe="take_screenshot")  → returns full JSON Schema for that tool

# Check status
/mcp                            → lists connected servers and tool counts
```

## Configuration

### File locations (loaded in order, later files override earlier ones)

| Path | Format | Scope |
|---|---|---|
| `.mcp.json` | OpenCode (`mcpServers`) | Project — shared with Cursor, Claude Code, Codex |
| `.pi/mcp.json` | pi format (`servers`) | Project — pi-specific overrides |

### Formats

OpenCode (`.mcp.json`, interops with Cursor, Claude Code, Codex):

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "web": {
      "url": "https://my-server.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

pi format (`.pi/mcp.json`, higher precedence):

```json
{
  "servers": {
    "fs": {
      "type": "local",
      "command": ["npx", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "web": {
      "type": "remote",
      "url": "https://my-server.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

### Auth

Bearer tokens go in `headers`. OAuth is intentionally not supported — it would
require a callback server, browser launch, and token storage, tripling the
codebase for a feature very few MCP servers actually need. For OAuth-dependent
servers, use [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) or
[pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  session_start                                               │
│    ↓ config.ts resolves .mcp.json + .pi/mcp.json             │
│    ↓ deduplicates servers by label (later files win)         │
│    ↓ transport.ts connects stdio / StreamableHTTP / SSE      │
│    ↓ tools.ts collects capabilities (tools, prompts, res)    │
│    ↓ builds <mcp_instructions> block (names only, no schema) │
│    ↓ registers per-server mcp_*_prompts / mcp_*_resources    │
│    ↓ sets up list_changed notifications for live refresh     │
│    ↓ refreshStatus() updates the status bar                  │
│                                                              │
│  before_agent_start (every LLM turn)                         │
│    ↓ rebuilds <mcp_instructions> from current state           │
│    ↓ appends to system prompt                                │
│    ↓ LLM sees: server names + tool names + descriptions       │
│                                                              │
│  mcp tool (LLM calls it)                                     │
│    ↓ search  → scan all tool names + descriptions            │
│    ↓ describe → find tool by name, return its JSON schema    │
│    ↓ tool call → lookup server, callTool(), guard output     │
│    ↓ abort   → return cancellation, server stays connected  │
│    ↓ errors  → pass server's structured error back to LLM    │
│                                                              │
│  session_shutdown                                            │
│    ↓ close all clients, clear state, clear status bar        │
└──────────────────────────────────────────────────────────────┘
```

### Design decisions

**Proxy dispatch over direct tool registration.**
Each MCP tool registered as a first-class Pi tool costs ~150-300 tokens in the
system prompt (name + description + schema). For servers with 50+ tools, that's
10k+ tokens before a single word of conversation. The single `mcp` dispatch
tool costs ~20 tokens regardless of how many servers are connected.

**Schema on demand, not pre-loaded.**
The `<mcp_instructions>` block carries only tool names and one-line
descriptions. Full JSON schemas are fetched reactively via
`mcp(describe="tool_name")` — the LLM pays token cost only for schemas it
actually inspects before calling.

**Content pass-through over lossy conversion.**
Images from MCP tools (screenshots, diagrams) are delivered to the model as
native image content rather than lossy text placeholders, preserving multimodal
capability.

**MCP server as validator.**
Tool arguments are forwarded to the MCP server without client-side schema
validation. The server returns structured errors that are surfaced directly
to the LLM for self-correction, eliminating the need to maintain a separate
JSON-Schema-to-TypeBox conversion layer.

**No OAuth.**
Bearer tokens via `headers` cover many auth-required MCP servers and keep
the extension lightweight. Full OAuth — callback server, browser launch,
token refresh, headless fallback — would add significant complexity. For
servers that require OAuth, use a dedicated adapter like
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

### Project structure

```
index.ts             Extension entry point — lifecycle hooks, mcp dispatch tool,
                     /mcp command, output guard
src/
  config.ts          Config file loading — .mcp.json (OpenCode) + .pi/mcp.json
  transport.ts       Transport creation — stdio, Streamable HTTP, SSE fallback
  tools.ts           Tool/Prompt/Resource management — capability collection,
                     content mapping, notification handlers, instruction builder
  types.ts           Shared type definitions
test/
  config.test.ts     Config parsing (both formats, warnings, precedence)
  transport.test.ts  Timeout and error utilities
  tools.test.ts      Content mapping, dispatch tools, notifications, pagination
  vendor-client.test.ts  Real SDK Client over in-memory transport
```

### Data flow

```
Config files
    ↓ resolveServerConfigs()
ServerConfig[]
    ↓ deduplicate by label (later files override)
ServerConfig[] (unique labels)
    ↓ connectServer() × N
connectToServerWithVersion()   ← stdio / StreamableHTTP / SSE
    ↓ collectServerCapabilities()
{tools[], hasPrompts, hasResources, serverInstructions}
    ↓ buildServerInstructions() → "instructions" string
    ↓ registerPromptsFromServer() / registerResourcesFromServer()
    ↓ mcpClients.set(name, info)

Each LLM turn:
    rebuildPromptBlock()
        → formatToolForInstructions() × N per server (name + description only)
        → <mcp_instructions> block appended to system prompt

LLM calls mcp():
    describe= → scan mcpClients[].tools[].name, return inputSchema
    search=   → scan mcpClients[].tools[].name + description
    tool=     → client.callTool(), mapContent(), guardText()
                → catch surfaces err.message + err.cause to LLM
```

### transports

| Type | Config | Implementation |
|---|---|---|
| stdio | `command` + `args` | `StdioClientTransport` — spawns subprocess |
| Streamable HTTP | `url` | `StreamableHTTPClientTransport` (MCP 2025-11-25+) |
| SSE | `url` (fallback) | `SSEClientTransport` — used if Streamable HTTP handshake fails |

### Lifecycle

Servers connect eagerly at session start — all at once, concurrently. Servers
with the same name from different config files (e.g. `.mcp.json` + `.pi/mcp.json`)
are deduplicated before connecting so `.pi/mcp.json` always wins deterministically.
There is no lazy/eager toggle or idle timeout. Every server that appears in the
config connects on startup and stays connected until session shutdown.

### Dependencies

- `@modelcontextprotocol/client` — MCP SDK v2 (modular, no ajv)
- `@earendil-works/pi-coding-agent` — Pi extension API
- `typebox` — Runtime type schemas (peer dependency, provided by pi)
