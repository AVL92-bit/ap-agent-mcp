import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const EXPECTED_INBOX_ID = "inb_bys7q";
const EXPECTED_TENANT_NAME = "St George's Road Surgery";
const TEST_SUPPLIER_NAME = "Aquacool Limited";
const TEST_INVOICE_NUMBER = "504694";

type TestMode = "connection" | "organisation" | "supplier" | "duplicate";

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  obtained_at: number;
  [key: string]: unknown;
};

type ConnectionRow = {
  connection_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_type: string;
  encrypted_tokens: string;
  enabled: boolean;
};

type XeroContact = {
  ContactID?: string;
  Name?: string;
  IsSupplier?: boolean;
};

type XeroInvoice = {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Contact?: {
    ContactID?: string;
  };
};

function encryptionKey(): Buffer {
  const raw = process.env.XERO_TOKEN_ENCRYPTION_KEY ?? "";

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("Xero encryption configuration is invalid");
  }

  return Buffer.from(raw, "hex");
}

function decrypt(value: string): StoredTokens {
  const parts = value.split(".");

  if (parts.length !== 3) {
    throw new Error("Stored Xero token format is invalid");
  }

  const [ivText, tagText, dataText] = parts;
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const data = Buffer.from(dataText, "base64url");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Stored Xero token format is invalid");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  const tokens = JSON.parse(plaintext) as StoredTokens;

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

function encrypt(tokens: StoredTokens): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);

  const data = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64url"))
    .join(".");
}

async function verifyPilotConnection(mode: TestMode) {
  if (process.env.FRONT_ENABLED_INBOX_ID !== EXPECTED_INBOX_ID) {
    throw new Error("Pilot inbox configuration does not match");
  }

  if (
    !process.env.DATABASE_URL ||
    !process.env.XERO_CLIENT_ID ||
    !process.env.XERO_CLIENT_SECRET
  ) {
    throw new Error("Xero test configuration is incomplete");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  let client: PoolClient | undefined;
  let transactionOpen = false;

  try {
    client = await pool.connect();

    // Lock the saved connection while checking and, if necessary,
    // rotating its refresh token.
    await client.query("BEGIN");
    transactionOpen = true;

    const result = await client.query<ConnectionRow>(
      `SELECT connection_id, tenant_id, tenant_name,
              tenant_type, encrypted_tokens, enabled
       FROM xero_oauth_connections
       FOR UPDATE`
    );

    if (
      result.rows.length !== 1 ||
      result.rows[0].tenant_name !== EXPECTED_TENANT_NAME ||
      result.rows[0].tenant_type !== "ORGANISATION" ||
      result.rows[0].enabled !== false ||
      !result.rows[0].connection_id ||
      !result.rows[0].tenant_id
    ) {
      throw new Error("Saved connection does not match the disabled pilot");
    }

    const connection = result.rows[0];
    let tokens = decrypt(connection.encrypted_tokens);
    let tokenRefreshed = false;

    const expiresIn =
      typeof tokens.expires_in === "number" &&
      Number.isFinite(tokens.expires_in)
        ? tokens.expires_in
        : 0;

    const expiresAt = tokens.obtained_at + expiresIn * 1000;

    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      const basicCredentials = Buffer.from(
        `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
      ).toString("base64");

      const refreshResponse = await fetch(
        "https://identity.xero.com/connect/token",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicCredentials}`,
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

      if (!refreshResponse.ok) {
        throw new Error(
          `Xero token refresh failed (HTTP ${refreshResponse.status})`
        );
      }

      const refreshed = (await refreshResponse.json()) as {
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

      tokens = {
        ...tokens,
        ...refreshed,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_in: refreshed.expires_in,
        obtained_at: Date.now(),
      };

      // Save the rotated refresh token before further Xero requests.
      await client.query(
        `UPDATE xero_oauth_connections
         SET encrypted_tokens = $1
         WHERE connection_id = $2`,
        [encrypt(tokens), connection.connection_id]
      );

      await client.query("COMMIT");
      transactionOpen = false;
      tokenRefreshed = true;
    } else {
      await client.query("COMMIT");
      transactionOpen = false;
    }

    // Verify the exact saved Xero connection.
    const connectionsResponse = await fetch(
      "https://api.xero.com/connections",
      {
        method: "GET",
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

    const connections = (await connectionsResponse.json()) as Array<{
      id?: string;
      tenantId?: string;
      tenantName?: string;
      tenantType?: string;
    }>;

    if (!Array.isArray(connections)) {
      throw new Error("Xero returned an unexpected connections response");
    }

    const matching = connections.filter(
      (item) =>
        item.id === connection.connection_id &&
        item.tenantId === connection.tenant_id &&
        item.tenantName === EXPECTED_TENANT_NAME &&
        item.tenantType === "ORGANISATION"
    );

    if (matching.length !== 1) {
      throw new Error("Xero did not confirm the exact pilot connection");
    }

    if (mode === "connection") {
      return {
        status: "ok",
        front_inbox_id: EXPECTED_INBOX_ID,
        tenant_name: EXPECTED_TENANT_NAME,
        tenant_type: "ORGANISATION",
        enabled: false,
        xero_connection_verified: true,
        token_refreshed: tokenRefreshed,
        accounting_data_accessed: false,
        bills_created: false,
      };
    }

    // Verify the pilot organisation before accessing contacts or invoices.
    const organisationResponse = await fetch(
      "https://api.xero.com/api.xro/2.0/Organisation",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "xero-tenant-id": connection.tenant_id,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!organisationResponse.ok) {
      throw new Error(
        `Xero organisation read failed (HTTP ${organisationResponse.status})`
      );
    }

    const organisationData = (await organisationResponse.json()) as {
      Organisations?: Array<{
        Name?: string;
        OrganisationID?: string;
      }>;
    };

    const organisations = organisationData?.Organisations;

    if (
      !Array.isArray(organisations) ||
      organisations.length !== 1 ||
      organisations[0].Name !== EXPECTED_TENANT_NAME ||
      typeof organisations[0].OrganisationID !== "string" ||
      !organisations[0].OrganisationID
    ) {
      throw new Error(
        "Xero accounting API organisation details do not match the pilot"
      );
    }

    if (mode === "organisation") {
      return {
        status: "ok",
        front_inbox_id: EXPECTED_INBOX_ID,
        tenant_name: EXPECTED_TENANT_NAME,
        tenant_type: "ORGANISATION",
        enabled: false,
        xero_connection_verified: true,
        token_refreshed: tokenRefreshed,
        accounting_api_verified: true,
        organisation_name_verified: true,
        organisation_details_read: true,
        invoices_read: false,
        contacts_read: false,
        bills_created: false,
      };
    }

    // Read-only exact-name supplier lookup.
    // Neither the supplier name nor tenant can be changed by the agent.
    const contactsUrl = new URL(
      "https://api.xero.com/api.xro/2.0/Contacts"
    );

    contactsUrl.searchParams.set(
      "where",
      `Name=="${TEST_SUPPLIER_NAME}"`
    );

    const contactsResponse = await fetch(contactsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "xero-tenant-id": connection.tenant_id,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!contactsResponse.ok) {
      throw new Error(
        `Xero supplier lookup failed (HTTP ${contactsResponse.status})`
      );
    }

    const contactsData = (await contactsResponse.json()) as {
      Contacts?: XeroContact[];
    };

    if (!contactsData || !Array.isArray(contactsData.Contacts)) {
      throw new Error("Xero returned an unexpected contacts response");
    }

    // Check locally as well; do not trust the API filter alone.
    const exactMatches = contactsData.Contacts.filter(
      (contact) => contact.Name === TEST_SUPPLIER_NAME
    );

    if (exactMatches.length !== contactsData.Contacts.length) {
      throw new Error("Xero returned contacts outside the exact-name lookup");
    }

    const uniqueMatch =
      exactMatches.length === 1 ? exactMatches[0] : undefined;

    if (mode === "supplier") {
      return {
        status: "ok",
        front_inbox_id: EXPECTED_INBOX_ID,
        tenant_name: EXPECTED_TENANT_NAME,
        tenant_type: "ORGANISATION",
        enabled: false,
        xero_connection_verified: true,
        token_refreshed: tokenRefreshed,
        accounting_api_verified: true,
        organisation_name_verified: true,
        supplier_name_searched: TEST_SUPPLIER_NAME,
        exact_match_count: exactMatches.length,
        unique_match: exactMatches.length === 1,
        is_supplier:
          uniqueMatch && typeof uniqueMatch.IsSupplier === "boolean"
            ? uniqueMatch.IsSupplier
            : null,
        contacts_read: true,
        invoices_read: false,
        bills_created: false,
        contacts_modified: false,
      };
    }

    // Fail closed: do not search invoices unless exactly one supplier
    // contact is verified and its ContactID is available.
    if (
      !uniqueMatch ||
      uniqueMatch.IsSupplier !== true ||
      typeof uniqueMatch.ContactID !== "string" ||
      !uniqueMatch.ContactID
    ) {
      throw new Error(
        "Duplicate test requires one verified supplier with a ContactID"
      );
    }

    const supplierContactId = uniqueMatch.ContactID;

    // Search bills (ACCPAY) by exact invoice number across the pilot
    // organisation. This also detects same-number bills under OTHER
    // suppliers rather than incorrectly reporting a clean result.
    //
    // Xero's paginated Invoices endpoint returns up to 100 records
    // per page. Continue until a short page; fail closed if the
    // safety limit is reached without confirming the final page.
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    const matchingInvoices: XeroInvoice[] = [];
    let searchComplete = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const invoicesUrl = new URL(
        "https://api.xero.com/api.xro/2.0/Invoices"
      );

      invoicesUrl.searchParams.set(
        "where",
        `Type=="ACCPAY"&&InvoiceNumber=="${TEST_INVOICE_NUMBER}"`
      );
      invoicesUrl.searchParams.set("page", String(page));

      const invoicesResponse = await fetch(invoicesUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "xero-tenant-id": connection.tenant_id,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!invoicesResponse.ok) {
        throw new Error(
          `Xero duplicate invoice lookup failed (HTTP ${invoicesResponse.status})`
        );
      }

      const invoicesData = (await invoicesResponse.json()) as {
        Invoices?: XeroInvoice[];
      };

      if (!invoicesData || !Array.isArray(invoicesData.Invoices)) {
        throw new Error("Xero returned an unexpected invoices response");
      }

      if (invoicesData.Invoices.length > PAGE_SIZE) {
        throw new Error("Xero returned an unexpected invoice page size");
      }

      for (const invoice of invoicesData.Invoices) {
        // Fail closed if Xero returns a record outside the requested
        // bill type or exact invoice number.
        if (
          invoice.Type !== "ACCPAY" ||
          invoice.InvoiceNumber !== TEST_INVOICE_NUMBER ||
          typeof invoice.InvoiceID !== "string" ||
          !invoice.InvoiceID ||
          typeof invoice.Contact?.ContactID !== "string" ||
          !invoice.Contact.ContactID
        ) {
          throw new Error(
            "Xero returned an invoice outside the verified duplicate search"
          );
        }

        matchingInvoices.push(invoice);
      }

      if (invoicesData.Invoices.length < PAGE_SIZE) {
        searchComplete = true;
        break;
      }
    }

    if (!searchComplete) {
      throw new Error(
        "Duplicate invoice search exceeded its page limit; result is inconclusive"
      );
    }

    const supplierMatches = matchingInvoices.filter(
      (invoice) => invoice.Contact?.ContactID === supplierContactId
    );

    const otherSupplierMatches = matchingInvoices.filter(
      (invoice) => invoice.Contact?.ContactID !== supplierContactId
    );

    return {
      status: "ok",
      front_inbox_id: EXPECTED_INBOX_ID,
      tenant_name: EXPECTED_TENANT_NAME,
      tenant_type: "ORGANISATION",
      enabled: false,
      xero_connection_verified: true,
      token_refreshed: tokenRefreshed,
      accounting_api_verified: true,
      organisation_name_verified: true,
      supplier_name_searched: TEST_SUPPLIER_NAME,
      supplier_verified: true,
      invoice_number_searched: TEST_INVOICE_NUMBER,
      search_complete: true,
      matching_supplier_bill_count: supplierMatches.length,
      same_number_other_supplier_bill_count: otherSupplierMatches.length,
      duplicate_found_for_supplier: supplierMatches.length > 0,
      same_number_other_supplier_review_required:
        otherSupplierMatches.length > 0,
      contacts_read: true,
      invoices_read: true,
      bills_created: false,
      bills_modified: false,
      contacts_modified: false,
    };
  } catch (error) {
    if (transactionOpen && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error without exposing credentials.
      }
    }

    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function testPilotXeroConnection() {
  return verifyPilotConnection("connection");
}

export async function testPilotXeroOrganisation() {
  return verifyPilotConnection("organisation");
}

export async function testPilotXeroSupplier() {
  return verifyPilotConnection("supplier");
}

export async function testPilotXeroDuplicateInvoice() {
  return verifyPilotConnection("duplicate");
}
