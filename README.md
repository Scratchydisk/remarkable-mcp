# remarkable-mcp

MCP server for reMarkable 2 — pull handwritten notes and diagrams into any AI agent.

Works with Claude Desktop, Claude Code, Codex, Cursor, and any MCP-compatible client.

## How it connects

- **USB connected:** uses the tablet's HTTP web interface (`http://10.11.99.1`) — fastest, no SSH needed
- **WiFi only:** falls back to SSH over the tablet's WiFi IP — requires SSH key setup

## Requirements

- Node.js 20+
- reMarkable 2 tablet

## Client configuration

No installation required — your MCP client will run the server via `npx` on first use.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "remarkable": {
      "command": "npx",
      "args": ["-y", "remarkable-mcp"]
    }
  }
}
```

### Claude Code

```json
{
  "mcp": {
    "servers": {
      "remarkable": {
        "command": "npx",
        "args": ["-y", "remarkable-mcp"]
      }
    }
  }
}
```

### Other MCP clients

Any client that supports stdio MCP servers:

```json
{
  "command": "npx",
  "args": ["-y", "remarkable-mcp"]
}
```

### Optional: global install (faster startup)

```bash
npm install -g remarkable-mcp
```

Then use `"command": "remarkable-mcp"` with no `args`.

## First-time setup

Connect your tablet via USB, then ask your agent:

> "Set up my reMarkable. The password is [password from Settings → Help → Copyright and licenses]."

The agent calls `remarkable_setup`, which:
1. Deploys an SSH keypair (for WiFi use)
2. Enables the USB web interface on the tablet
3. Discovers and saves your tablet's WiFi IP

## Tools

### `remarkable_setup`

First-time configuration. Requires the root password shown on the tablet under **Settings → Help → Copyright and licenses**.

### `remarkable_list`

Lists all documents on the tablet, sorted by most recently modified.

### `remarkable_pull`

Pulls a document and returns rendered page images. Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `document` | string? | Document name substring (defaults to most recent) |
| `page` | number? | Specific page number 1-based (defaults to all pages) |
| `prompt` | string? | Custom transcription instruction |

## OCR modes

Set in `~/.config/remarkable-mcp/config.json`:

- **native** (default): the host agent's LLM reads the image directly — no extra API key needed
- **ollama**: sends image to a local Ollama instance (`llama3.2-vision` or configured model)
- **local**: shells out to Tesseract for plain-text output

## Licence

MIT
