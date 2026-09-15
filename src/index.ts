import http from "node:http";
import { timingSafeEqual } from "node:crypto";
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

  server.registerTool(
    "ap_connection_test",
    {
      title: "AP Connection Test",
      description:
        "Harmless diagnostic tool that confirms the AP MCP server is connected. Does not access Front, Xero, or any external business data.",
    },
    async () => {
      const result = {
        status: "ok",
        service: "ap-mcp-server",
        front_configured: Boolean(process.env.FRONT_API_TOKEN),
        xero_configured: Boolean(process.env.XERO_CLIENT_ID),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
  server.registerTool(
    "list_front_inboxes",
    {
      title: "List Front Inboxes",
      description:
        "Temporary read-only setup tool that lists Front inbox names and IDs so an administrator can select the single pilot AP inbox. Does not read messages, attachments, or modify Front.",
    },
    async () => {
      const frontToken = process.env.FRONT_API_TOKEN;

      if (!frontToken) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "FRONT_API_TOKEN is not configured",
              }),
            },
          ],
          isError: true,
        };
      }

      const response = await fetch("https://api2.frontapp.com/inboxes", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${frontToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Front API request failed",
                http_status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as {
        _results?: Array<{
          id?: string;
          name?: string;
        }>;
      };

      const inboxes = (data._results ?? []).map((inbox) => ({
        id: inbox.id ?? null,
        name: inbox.name ?? null,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              inbox_count: inboxes.length,
              inboxes,
            }),
          },
        ],
      };
    }
  );
  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

function isAuthorized(req: http.IncomingMessage): boolean {
  const expectedToken = process.env.MCP_AUTH_TOKEN;

  if (!expectedToken) {
    console.error("MCP_AUTH_TOKEN is not configured");
    return false;
  }

  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const suppliedToken = authorization.slice("Bearer ".length);

  const suppliedBuffer = Buffer.from(suppliedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  if (suppliedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  // Public Railway health check.
  // This deliberately does not require MCP authentication.
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

  // All MCP traffic requires the shared bearer token.
  if (url.pathname === "/mcp") {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });

      res.end(
        JSON.stringify({
          error: "Unauthorized",
        })
      );

      return;
    }

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
