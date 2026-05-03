# Scripts

Local developer utilities. Not shipped to npm (see `files` in `package.json`).

## kill-desktop.sh

Kills any running Claude Desktop process on Linux. Useful when iterating on the MCP server: Claude Desktop holds the spawned `remarkable-mcp` stdio process open, so a fresh `npm run build` is not picked up until the desktop app is restarted.

Usage:

```bash
./scripts/kill-desktop.sh
```

Then relaunch Claude Desktop and it will spawn the rebuilt server.
