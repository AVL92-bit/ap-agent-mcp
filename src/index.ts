import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Initialize the MCP server
const mcpServer = new Server(
  {
    name: "ap-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {},
  }
);

// List available tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "placeholder",
        description: "Placeholder tool - real tools coming in phase 2",
        inputSchema: {
          type: "object" as const,
          properties: {
            message: {
              type: "string",
              description: "A message",
            },
          },
          required: ["message"],
        },
      },
    ],
  };
});

// Handle tool calls
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "placeholder") {
    return {
      content: [
        {
          type: "text",
          text: `Placeholder response: ${(args as { message: string }).message}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${name}`,
      },
    ],
    isError: true,
  };
});

// HTTP server for /health and /mcp endpoints
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health endpoint
  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // MCP endpoint
  if (pathname === "/mcp") {
    try {
      const contentType = req.headers["content-type"];
      if (!contentType || !contentType.includes("application/json")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const request = JSON.parse(body);
          const response = await mcpServer.handleRequest(request);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (error) {
          console.error("MCP handling error:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
      return;
    } catch (error) {
      console.error("MCP error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  // 404 for unknown endpoints
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Start the server
const port = parseInt(process.env.PORT || "3000", 10);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`MCP server running on port ${port}`);
  console.log(`  Health: http://localhost:${port}/health`);
  console.log(`  MCP: http://localhost:${port}/mcp`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  httpServer.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
