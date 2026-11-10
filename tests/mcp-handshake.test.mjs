import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

// Exercise the same MCP SDK handler/Node adapter used in production, without
// business credentials, databases, or any Xero/Front side effects.
test('MCP HTTP initialize and tools/list expose registered tools', async () => {
  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new McpServer({ name: 'handshake-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('ap_connection_test', {
      description: 'Read-only handshake diagnostic',
    }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    return server;
  }));
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const post = async (body, session) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      const data = text.includes('data: ')
        ? JSON.parse(text.split('\\n').find(line => line.startsWith('data: ')).slice(6))
        : JSON.parse(text);
      return { response, data };
    };
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'handshake-test', version: '1' } },
    });
    assert.equal(init.response.status, 200);
    assert.equal(init.data.result.serverInfo.name, 'handshake-test');
    const session = init.response.headers.get('mcp-session-id');
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
    assert.equal(listed.response.status, 200);
    assert.ok(listed.data.result.tools.some(tool => tool.name === 'ap_connection_test'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
