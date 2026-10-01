import type http from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Pool } from "pg";

// Xero OAuth and operator-only connection testing.
// No bill creation, approval or payment functionality.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

const REDIRECT =
  "https://ap-agent-mcp-production.up.railway.app/xero/callback";

const SCOPES =
  "offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read";

const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

type XeroTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
};

type XeroConnection = {
  connection_id: string;
  tenant_id: string;
  encrypted_tokens: string;
  enabled: boolean;
};

function send(
  res: http.ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {}
): void {
  res.writeHead(status, {
    ...htmlHeaders,
    ...extra,
  });

  res.end(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Xero connection</title>
</head>
<body>
<h1>Xero connection</h1>
<p>${message}</p>
</body>
</html>`
  );
}

function digest(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function encryptionKey(): Buffer {
  const raw =
    process.env.XERO_TOKEN_ENCRYPTION_KEY ?? "";

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error(
      "XERO_TOKEN_ENCRYPTION_KEY must contain exactly 64 hex characters"
    );
  }

  return Buffer.from(raw, "hex");
}

function encrypt(value: string): string {
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return [
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decrypt(value: string): string {
  const parts = value.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const [iv, tag, encrypted] = parts.map(
    (part) => Buffer.from(part, "base64url")
  );

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    iv
  );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xero_oauth_states (
      state_hash text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xero_oauth_connections (
      connection_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      tenant_name text NOT NULL,
      tenant_type text NOT NULL,
      encrypted_tokens text NOT NULL,
      connected_at timestamptz NOT NULL DEFAULT now(),
      enabled boolean NOT NULL DEFAULT false
    )
  `);
}

function basicAuthorized(
  req: http.IncomingMessage
): boolean {
  const expected =
    process.env.XERO_SETUP_PASSWORD;

  const header =
    req.headers.authorization;

  if (
    !expected ||
    !header?.startsWith("Basic ")
  ) {
    return false;
  }

  let credentials: string;

  try {
    credentials = Buffer.from(
      header.slice(6),
      "base64"
    ).toString("utf8");
  } catch {
    return false;
  }

  const separator =
    credentials.indexOf(":");

  if (
    separator < 0 ||
    credentials.slice(0, separator) !== "admin"
  ) {
    return false;
  }

  const supplied = Buffer.from(
    credentials.slice(separator + 1)
  );

  const actual = Buffer.from(expected);

  return (
    supplied.length === actual.length &&
    timingSafeEqual(supplied, actual)
  );
}

function cookie(
  req: http.IncomingMessage,
  name: string
): string | undefined {
  const match = (
    req.headers.cookie ?? ""
  )
    .split(";")
    .map((part) => part.trim())
    .find((part) =>
      part.startsWith(`${name}=`)
    );

  return match?.slice(name.length + 1);
}

const clearCookie =
  "xero_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/xero; Max-Age=0";

function xeroClientAuthorization(): string {
  const clientId =
    process.env.XERO_CLIENT_ID;

  const clientSecret =
    process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Xero client credentials are missing"
    );
  }

  return (
    "Basic " +
    Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64")
  );
}

// Refresh tokens only for the explicitly selected
// connection. Never refresh every organisation.

async function getPilotAccessToken(
  connectionId: string,
  encryptedTokens: string
): Promise<string> {
  const tokens = JSON.parse(
    decrypt(encryptedTokens)
  ) as XeroTokens;

  if (
    !tokens.access_token ||
    !tokens.refresh_token ||
    !tokens.obtained_at
  ) {
    throw new Error(
      "Stored Xero tokens are incomplete"
    );
  }

  const expiresIn =
    typeof tokens.expires_in === "number"
      ? tokens.expires_in
      : 1800;

  const expiry =
    tokens.obtained_at +
    expiresIn * 1000;

  // Keep a two-minute safety margin.
  if (Date.now() < expiry - 120000) {
    return tokens.access_token;
  }

  const response = await fetch(
    "https://identity.xero.com/connect/token",
    {
      method: "POST",
      headers: {
        Authorization:
          xeroClientAuthorization(),
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token:
          tokens.refresh_token,
      }),
      signal:
        AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      "Xero token refresh failed"
    );
  }

  const refreshed =
    (await response.json()) as
      Partial<XeroTokens>;

  if (
    !refreshed.access_token ||
    !refreshed.refresh_token
  ) {
    throw new Error(
      "Xero returned incomplete refreshed tokens"
    );
  }

  const updated: XeroTokens = {
    access_token:
      refreshed.access_token,
    refresh_token:
      refreshed.refresh_token,
    expires_in:
      refreshed.expires_in ?? 1800,
    obtained_at: Date.now(),
  };

  // Replace tokens only if this row still
  // contains the tokens we originally read.
  // This prevents overwriting a newer token
  // saved by another request.
  const saved = await pool.query(
    `UPDATE xero_oauth_connections
     SET encrypted_tokens = $1
     WHERE connection_id = $2
       AND encrypted_tokens = $3`,
    [
      encrypt(JSON.stringify(updated)),
      connectionId,
      encryptedTokens,
    ]
  );

  if (saved.rowCount !== 1) {
    throw new Error(
      "Connection tokens changed during refresh; retry the test"
    );
  }

  return updated.access_token;
}

// Operator-only live verification.
// This works even when enabled is false.
// It is not exposed as an MCP tool.

async function checkLivePilot(
  res: http.ServerResponse
): Promise<void> {
  const pilotId =
    process.env.XERO_PILOT_TENANT_ID;

  if (!pilotId) {
    send(
      res,
      503,
      "Pilot organisation is not configured."
    );
    return;
  }

  const result = await pool.query(
    `SELECT
       connection_id,
       tenant_id,
       encrypted_tokens,
       enabled
     FROM xero_oauth_connections
     WHERE tenant_id = $1`,
    [pilotId]
  );

  if (result.rowCount !== 1) {
    send(
      res,
      409,
      "Pilot organisation verification failed."
    );
    return;
  }

  const connection =
    result.rows[0] as XeroConnection;

  if (
    connection.tenant_id !== pilotId
  ) {
    send(
      res,
      409,
      "Stored organisation does not match the pilot configuration."
    );
    return;
  }

  const accessToken =
    await getPilotAccessToken(
      connection.connection_id,
      connection.encrypted_tokens
    );

  const response = await fetch(
    "https://api.xero.com/api.xro/2.0/Organisation",
    {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
        "Xero-tenant-id": pilotId,
        Accept: "application/json",
      },
      signal:
        AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    console.error(
      "Live Xero organisation request failed",
      response.status
    );

    send(
      res,
      502,
      "Live Xero API verification failed. Check Railway logs."
    );
    return;
  }

  const data =
    (await response.json()) as {
      Organisations?: Array<{
        OrganisationID?: string;
      }>;
    };

  const organisations =
    data.Organisations ?? [];

  if (
    organisations.length !== 1 ||
    organisations[0].OrganisationID
      ?.toLowerCase() !==
      pilotId.toLowerCase()
  ) {
    send(
      res,
      409,
      "Live Xero organisation does not match the pilot configuration."
    );
    return;
  }

  send(
    res,
    200,
    connection.enabled
      ? "Live Xero API verified. Correct pilot organisation. Connection is enabled."
      : "Live Xero API verified. Correct pilot organisation. Connection remains disabled."
  );
}

export async function handleXeroOAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (
    url.pathname !== "/xero/connect" &&
    url.pathname !== "/xero/callback" &&
    url.pathname !== "/xero/status"
  ) {
    return false;
  }

  if (req.method !== "GET") {
    send(
      res,
      405,
      "Method not allowed."
    );
    return true;
  }

  let setupStage =
    "configuration check";

  try {
    if (
      !process.env.DATABASE_URL ||
      !process.env.XERO_CLIENT_ID ||
      !process.env.XERO_CLIENT_SECRET ||
      process.env.XERO_REDIRECT_URI !==
        REDIRECT
    ) {
      send(
        res,
        503,
        "Xero configuration is incomplete or the redirect URI does not match."
      );
      return true;
    }

    setupStage =
      "encryption key validation";

    encryptionKey();

    setupStage =
      "PostgreSQL table setup";

    await ensureTables();

    setupStage =
      "request handling";

    // STATUS: authenticated, live,
    // read-only pilot organisation check.

    if (
      url.pathname === "/xero/status"
    ) {
      if (!basicAuthorized(req)) {
        send(
          res,
          401,
          "Operator authentication required.",
          {
            "WWW-Authenticate":
              'Basic realm="AP Xero setup"',
          }
        );
        return true;
      }

      setupStage =
        "live pilot verification";

      await checkLivePilot(res);
      return true;
    }

    // CONNECT: operator initiates OAuth.

    if (
      url.pathname === "/xero/connect"
    ) {
      if (!basicAuthorized(req)) {
        send(
          res,
          401,
          "Operator authentication required.",
          {
            "WWW-Authenticate":
              'Basic realm="AP Xero setup"',
          }
        );
        return true;
      }

      const state = randomBytes(32)
        .toString("base64url");

      await pool.query(`
        DELETE FROM xero_oauth_states
        WHERE created_at <
          now() - interval '10 minutes'
      `);

      await pool.query(
        `INSERT INTO xero_oauth_states
           (state_hash)
         VALUES ($1)`,
        [digest(state)]
      );

      const target = new URL(
        "https://login.xero.com/identity/connect/authorize"
      );

      target.searchParams.set(
        "response_type",
        "code"
      );

      target.searchParams.set(
        "client_id",
        process.env.XERO_CLIENT_ID!
      );

      target.searchParams.set(
        "redirect_uri",
        REDIRECT
      );

      target.searchParams.set(
        "scope",
        SCOPES
      );

      target.searchParams.set(
        "state",
        state
      );

      res.writeHead(302, {
        Location:
          target.toString(),
        "Cache-Control":
          "no-store",
        "Referrer-Policy":
          "no-referrer",
        "Set-Cookie":
          `xero_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/xero; Max-Age=600`,
      });

      res.end();
      return true;
    }

    // CALLBACK: validate state before
    // exchanging the authorisation code.

    const state =
      url.searchParams.get("state") ?? "";

    const browserState =
      cookie(
        req,
        "xero_oauth_state"
      ) ?? "";

    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      state !== browserState
    ) {
      send(
        res,
        400,
        "Invalid or expired authorisation session. Start again from /xero/connect.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    const used = await pool.query(
      `DELETE FROM xero_oauth_states
       WHERE state_hash = $1
         AND created_at >
           now() - interval '10 minutes'
       RETURNING state_hash`,
      [digest(state)]
    );

    if (used.rowCount !== 1) {
      send(
        res,
        400,
        "This authorisation session has expired or already been used.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    if (
      url.searchParams.has("error")
    ) {
      send(
        res,
        400,
        "Xero authorisation was cancelled or declined. No connection was saved.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    const code =
      url.searchParams.get("code");

    if (!code) {
      send(
        res,
        400,
        "Xero did not return an authorisation code.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    setupStage =
      "Xero token exchange";

    const tokenResponse =
      await fetch(
        "https://identity.xero.com/connect/token",
        {
          method: "POST",
          headers: {
            Authorization:
              xeroClientAuthorization(),
            "Content-Type":
              "application/x-www-form-urlencoded",
            Accept:
              "application/json",
          },
          body:
            new URLSearchParams({
              grant_type:
                "authorization_code",
              code,
              redirect_uri:
                REDIRECT,
            }),
          signal:
            AbortSignal.timeout(20000),
        }
      );

    if (!tokenResponse.ok) {
      send(
        res,
        502,
        "Xero token exchange failed. Start a new connection attempt.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    const tokens =
      (await tokenResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

    if (
      !tokens.access_token ||
      !tokens.refresh_token
    ) {
      send(
        res,
        502,
        "Xero did not provide the required offline tokens.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    setupStage =
      "Xero connection discovery";

    const connectionsResponse =
      await fetch(
        "https://api.xero.com/connections",
        {
          headers: {
            Authorization:
              `Bearer ${tokens.access_token}`,
            Accept:
              "application/json",
          },
          signal:
            AbortSignal.timeout(20000),
        }
      );

    if (!connectionsResponse.ok) {
      send(
        res,
        502,
        "Could not verify Xero organisation connections. No tokens were stored.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    const connections =
      (await connectionsResponse.json()) as
        Array<{
          id?: string;
          tenantId?: string;
          tenantName?: string;
          tenantType?: string;
        }>;

    if (
      !Array.isArray(connections) ||
      connections.length === 0 ||
      connections.some(
        (connection) =>
          !connection.id ||
          !connection.tenantId ||
          !connection.tenantName
      )
    ) {
      send(
        res,
        502,
        "Xero returned no usable organisation connections. No tokens were stored.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
      return true;
    }

    // Store tokens encrypted.
    // Every newly authorised connection
    // remains disabled.

    const encrypted = encrypt(
      JSON.stringify({
        ...tokens,
        obtained_at:
          Date.now(),
      })
    );

    setupStage =
      "connection storage";

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      for (
        const connection of connections
      ) {
        await client.query(
          `INSERT INTO
             xero_oauth_connections
             (
               connection_id,
               tenant_id,
               tenant_name,
               tenant_type,
               encrypted_tokens
             )
           VALUES
             ($1, $2, $3, $4, $5)
           ON CONFLICT
             (connection_id)
           DO UPDATE SET
             tenant_id =
               EXCLUDED.tenant_id,
             tenant_name =
               EXCLUDED.tenant_name,
             tenant_type =
               EXCLUDED.tenant_type,
             encrypted_tokens =
               EXCLUDED.encrypted_tokens,
             connected_at =
               now(),
             enabled =
               false`,
          [
            connection.id,
            connection.tenantId,
            connection.tenantName,
            connection.tenantType ??
              "UNKNOWN",
            encrypted,
          ]
        );
      }

      await client.query(
        "COMMIT"
      );
    } catch (error) {
      await client.query(
        "ROLLBACK"
      );
      throw error;
    } finally {
      client.release();
    }

    send(
      res,
      200,
      `Authorisation completed. ${connections.length} Xero connection(s) recorded, all disabled pending pilot-entity verification. You can close this tab.`,
      {
        "Set-Cookie":
          clearCookie,
      }
    );

    return true;
  } catch {
    console.error(
      `Xero OAuth setup failed at stage: ${setupStage}`
    );

    if (
      setupStage ===
      "encryption key validation"
    ) {
      const raw =
        process.env
          .XERO_TOKEN_ENCRYPTION_KEY ??
        "";

      console.error(
        `Xero encryption key diagnostic: present=${raw.length > 0}; character_count=${raw.length}; hex_characters_only=${/^[a-fA-F0-9]*$/.test(raw)}`
      );
    }

    if (!res.headersSent) {
      send(
        res,
        500,
        "Setup failed. Check Railway deployment and configuration. Do not share credentials or callback URLs containing a code.",
        {
          "Set-Cookie":
            clearCookie,
        }
      );
    }

    return true;
  }
}
