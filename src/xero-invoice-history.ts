import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Pool } from "pg";

const PILOT_INBOX = "inb_bys7q";
const PILOT_NAME = "St George's Road Surgery";

type SavedConnection = {
  connection_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_type: string;
  encrypted_tokens: string;
  enabled: boolean;
};

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  [key: string]: unknown;
};

type HistoryInvoice = {
  Type?: string;
  Status?: string;
  InvoiceNumber?: string;
  DateString?: string;
  Contact?: {
    Name?: string;
  };
  LineItems?: Array<{
    Description?: string;
    AccountCode?: string;
    LineAmount?: number;
    TaxType?: string;
  }>;
};

function getEncryptionKey(): Buffer {
  const value = process.env.XERO_TOKEN_ENCRYPTION_KEY ?? "";

  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Xero encryption configuration is invalid");
  }

  return Buffer.from(value, "hex");
}

function decryptTokens(value: string): Tokens {
  const parts = value.split(".");

  if (parts.length !== 3) {
    throw new Error("Stored Xero token format is invalid");
  }

  const iv = Buffer.from(parts[0], "base64url");
  const tag = Buffer.from(parts[1], "base64url");
  const encrypted = Buffer.from(parts[2], "base64url");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Stored Xero token format is invalid");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");

  const tokens = JSON.parse(plaintext) as Tokens;

  if (
    !tokens ||
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token ||
    typeof tokens.obtained_at !== "number"
  ) {
    throw new Error("Stored Xero tokens are incomplete");
  }

  return tokens;
}

function encryptTokens(tokens: Tokens): string {
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);

  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

async function refreshIfNeeded(
  tokens: Tokens
): Promise<{
  tokens: Tokens;
  refreshed: boolean;
}> {
  const expiresIn =
    typeof tokens.expires_in === "number" &&
    Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : 0;

  const expiresAt =
    tokens.obtained_at + expiresIn * 1000;

  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return {
      tokens,
      refreshed: false,
    };
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Xero OAuth configuration is incomplete");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    "https://identity.xero.com/connect/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Xero token refresh failed (HTTP ${response.status})`
    );
  }

  const refreshed = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (
    !refreshed.access_token ||
    !refreshed.refresh_token ||
    typeof refreshed.expires_in !== "number" ||
    !Number.isFinite(refreshed.expires_in) ||
    refreshed.expires_in <= 0
  ) {
    throw new Error("Xero returned incomplete refreshed tokens");
  }

  return {
    tokens: {
      ...tokens,
      ...refreshed,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_in: refreshed.expires_in,
      obtained_at: Date.now(),
    },
    refreshed: true,
  };
}

export async function testPilotXeroInvoiceHistory(
  search?: {
    supplier_name?: string;
    description_query?: string;
  }
) {
  if (
    process.env.FRONT_ENABLED_INBOX_ID !== PILOT_INBOX ||
    !process.env.XERO_PILOT_TENANT_ID ||
    !process.env.DATABASE_URL
  ) {
    throw new Error("Pilot configuration is incomplete or incorrect");
  }
const supplierQuery = search?.supplier_name?.trim() ?? "";
  const descriptionQuery = search?.description_query?.trim() ?? "";

  if (
    supplierQuery.length > 150 ||
    descriptionQuery.length > 150
  ) {
    throw new Error("History search criteria are too long");
  }

  if (
    search &&
    !supplierQuery &&
    !descriptionQuery
  ) {
    throw new Error("History search requires a search term");
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    // Keep the connection row locked while checking
    // whether its rotating OAuth token needs refreshing.
    await client.query("BEGIN");
    transactionOpen = true;

    const saved = await client.query<SavedConnection>(
      `SELECT connection_id, tenant_id, tenant_name,
              tenant_type, encrypted_tokens, enabled
       FROM xero_oauth_connections
       WHERE tenant_id = $1
       FOR UPDATE`,
      [process.env.XERO_PILOT_TENANT_ID]
    );

    if (
      saved.rows.length !== 1 ||
      saved.rows[0].tenant_name !== PILOT_NAME ||
      saved.rows[0].tenant_type !== "ORGANISATION" ||
      saved.rows[0].enabled !== false ||
      !saved.rows[0].connection_id
    ) {
      throw new Error(
        "Saved connection does not match the disabled pilot"
      );
    }

    const connection = saved.rows[0];

    const tokenResult = await refreshIfNeeded(
      decryptTokens(connection.encrypted_tokens)
    );

    const tokens = tokenResult.tokens;

    if (tokenResult.refreshed) {
      await client.query(
        `UPDATE xero_oauth_connections
         SET encrypted_tokens = $1
         WHERE connection_id = $2`,
        [
          encryptTokens(tokens),
          connection.connection_id,
        ]
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;

    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      "xero-tenant-id": connection.tenant_id,
      Accept: "application/json",
    };

    // Verify the exact authorised Xero connection.
    const connectionsResponse = await fetch(
      "https://api.xero.com/connections",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!connectionsResponse.ok) {
      throw new Error(
        `Xero connection verification failed (HTTP ${connectionsResponse.status})`
      );
    }

    const connections =
      (await connectionsResponse.json()) as Array<{
        id?: string;
        tenantId?: string;
        tenantName?: string;
        tenantType?: string;
      }>;

    if (
      !Array.isArray(connections) ||
      connections.filter(
        (item) =>
          item.id === connection.connection_id &&
          item.tenantId === connection.tenant_id &&
          item.tenantName === PILOT_NAME &&
          item.tenantType === "ORGANISATION"
      ).length !== 1
    ) {
      throw new Error("Exact pilot Xero connection not verified");
    }

    // Verify the live accounting organisation.
    const organisationResponse = await fetch(
      "https://api.xero.com/api.xro/2.0/Organisation",
      {
        headers,
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!organisationResponse.ok) {
      throw new Error(
        `Xero organisation verification failed (HTTP ${organisationResponse.status})`
      );
    }

    const organisationData =
      (await organisationResponse.json()) as {
        Organisations?: Array<{
          Name?: string;
          OrganisationID?: string;
        }>;
      };

    if (
      !Array.isArray(organisationData.Organisations) ||
      organisationData.Organisations.length !== 1 ||
      organisationData.Organisations[0].Name !== PILOT_NAME ||
      !organisationData.Organisations[0].OrganisationID
    ) {
      throw new Error("Live Xero organisation does not match pilot");
    }

    // Retrieve a deliberately limited historical sample.
    // This is NOT a search of the entire Xero history.
// Targeted searches can examine more historical bills.
    // The existing test keeps its original limits.
    const PAGE_LIMIT = search ? 10 : 3;
    const PAGE_SIZE = 100;
    const MAX_EXAMPLES = search ? 50 : 30;

    const examples: Array<{
      supplier: string;
      invoice_number: string;
      date: string | null;
      description: string;
      account_code: string;
      line_amount: number | null;
      historical_tax_type: string | null;
    }> = [];

    let scannedBills = 0;
    let reachedEnd = false;

    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const url = new URL(
        "https://api.xero.com/api.xro/2.0/Invoices"
      );

      url.searchParams.set("where", 'Type=="ACCPAY"');
      url.searchParams.set("order", "Date DESC");
      url.searchParams.set("page", String(page));

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        throw new Error(
          `Xero invoice history read failed (HTTP ${response.status})`
        );
      }

      const data = (await response.json()) as {
        Invoices?: HistoryInvoice[];
      };

      if (
        !Array.isArray(data.Invoices) ||
        data.Invoices.length > PAGE_SIZE
      ) {
        throw new Error(
          "Xero returned an unexpected invoice history page"
        );
      }

      for (const invoice of data.Invoices) {
        if (invoice.Type !== "ACCPAY") {
          throw new Error(
            "Xero returned a non-purchase invoice in history"
          );
        }

        scannedBills++;
// For targeted searches, filter by supplier.
        if (
          supplierQuery &&
          !(invoice.Contact?.Name ?? "")
            .toLowerCase()
            .includes(supplierQuery.toLowerCase())
        ) {
          continue;
        }
        // Only use authorised or paid bills as evidence.
        if (
          invoice.Status !== "AUTHORISED" &&
          invoice.Status !== "PAID"
        ) {
          continue;
        }

        for (const line of invoice.LineItems ?? []) {
          // For targeted searches, match invoice descriptions.
          if (
            descriptionQuery &&
            !(line.Description ?? "")
              .toLowerCase()
              .includes(descriptionQuery.toLowerCase())
          ) {
            continue;
          }

          if (
            !line.AccountCode ||
            !line.Description?.trim()
          ) {
            continue;
          }

          if (examples.length >= MAX_EXAMPLES) {
            break;
          }
          examples.push({
            supplier: (invoice.Contact?.Name ?? "").slice(
              0,
              150
            ),
            invoice_number: (
              invoice.InvoiceNumber ?? ""
            ).slice(0, 100),
            date: invoice.DateString ?? null,
            description: line.Description.slice(0, 500),
            account_code: line.AccountCode,
            line_amount:
              typeof line.LineAmount === "number"
                ? line.LineAmount
                : null,
            historical_tax_type: line.TaxType ?? null,
          });
        }
      }

      if (data.Invoices.length < PAGE_SIZE) {
        reachedEnd = true;
        break;
      }

      if (examples.length >= MAX_EXAMPLES) {
        break;
      }
    }

    return {
      status: "ok",
      tenant_name: PILOT_NAME,
      enabled: false,
      search_mode: search ? "targeted" : "sample",
      search_criteria: search
        ? {
            supplier_name: supplierQuery || null,
            description_query: descriptionQuery || null,
          }
        : null,
      matching_invoice_lines: examples.length,
      search_complete: reachedEnd,
      xero_connection_verified: true,
      organisation_name_verified: true,
      token_refreshed: tokenResult.refreshed,
      historical_bills_scanned: scannedBills,
      historical_examples: examples,
      sample_limited:
        !reachedEnd || examples.length >= MAX_EXAMPLES,
      historical_data_is_evidence_only: true,
      pilot_default_tax_type_for_future_proposals: "NONE",
      gross_cost_coding_requires_human_review: true,
      account_code_selected: false,
      bills_created: false,
      bills_modified: false,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
