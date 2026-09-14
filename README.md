# AP MCP Server

A Model Context Protocol server for AP (Accounts Payable) automation.

## Endpoints

- `GET /health` - Health check, returns `{"status":"ok"}`
- `POST /mcp` - MCP protocol endpoint for Claude integration

## Development

```bash
npm install
npm run dev
