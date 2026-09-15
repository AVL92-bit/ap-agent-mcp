import http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

function buildMcpServer() {
  const server = new McpServer(
    {
      name: "ap-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);

const nodeMcpHandler = toNodeHandler(mcpHandler);

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  // Railway health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "ap-mcp-server",
      })
    );

    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    await nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not found",
    })
  );
});

const port = Number(process.env.PORT || 3000);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`AP MCP server listening on port ${port}`);
  console.log("Health endpoint: /health");
  console.log("MCP endpoint: /mcp");
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received");

  httpServer.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
