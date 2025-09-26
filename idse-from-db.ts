import { query } from "./db";

/**
 * List ONLY clients with COMPLETE IDSE setup (ready to use)
 */
export async function listCompleteIDSEClients(): Promise<any[]> {
  const sql = `
    SELECT
      c.id,
      c.business_name,
      c.trade_name,
      c.tax_id,
      c.idse_user,
      c.idse_password,
      c.sync_idse,
      CASE
        WHEN pfx.id IS NOT NULL THEN 'PFX'
        WHEN cer.id IS NOT NULL AND key.id IS NOT NULL THEN 'CER+KEY'
      END as cert_type,
      pfx.name as pfx_filename,
      pfx.url as pfx_url,
      cer.name as cer_filename,
      cer.url as cer_url,
      key.name as key_filename,
      key.url as key_url
    FROM clients c
    LEFT JOIN (
      SELECT
        frm.related_id as client_id,
        f.id,
        f.name,
        f.url
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseCerPFX'
    ) pfx ON pfx.client_id = c.id
    LEFT JOIN (
      SELECT
        frm.related_id as client_id,
        f.id,
        f.name,
        f.url
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseCer'
    ) cer ON cer.client_id = c.id
    LEFT JOIN (
      SELECT
        frm.related_id as client_id,
        f.id,
        f.name,
        f.url
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseKey'
    ) key ON key.client_id = c.id
    WHERE c.idse_user IS NOT NULL
    AND c.idse_password IS NOT NULL
    AND (
      pfx.id IS NOT NULL
      OR (cer.id IS NOT NULL AND key.id IS NOT NULL)
    )
    ORDER BY c.sync_idse DESC, c.business_name
  `;

  return await query(sql);
}

// Main function - ONLY show complete clients
async function main() {
  console.log("\n=== IDSE Ready Clients ===\n");

  try {
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients ready for IDSE\n`);

    // Group by sync status
    const syncEnabled = clients.filter(c => c.sync_idse);
    const syncDisabled = clients.filter(c => !c.sync_idse);

    // Group by certificate type
    const pfxClients = clients.filter(c => c.cert_type === 'PFX');
    const cerKeyClients = clients.filter(c => c.cert_type === 'CER+KEY');

    console.log("📈 SUMMARY:");
    console.log(`   Total Ready: ${clients.length} clients`);
    console.log(`   Sync Enabled: ${syncEnabled.length} clients`);
    console.log(`   Sync Disabled: ${syncDisabled.length} clients`);
    console.log("");
    console.log("🔐 CERTIFICATE TYPES:");
    console.log(`   Using PFX: ${pfxClients.length} clients`);
    console.log(`   Using CER+KEY: ${cerKeyClients.length} clients`);
    console.log("");

    // List sync-enabled clients first
    if (syncEnabled.length > 0) {
      console.log("✅ SYNC ENABLED (Active):\n");
      syncEnabled.forEach((client, index) => {
        console.log(`${index + 1}. [ID: ${client.id}] ${client.business_name}`);
        console.log(`   RFC: ${client.tax_id || "N/A"}`);
        console.log(`   IDSE User: ${client.idse_user}`);
        console.log(`   Type: ${client.cert_type}`);

        if (client.cert_type === 'PFX') {
          console.log(`   File: ${client.pfx_filename}`);
        } else {
          console.log(`   CER: ${client.cer_filename}`);
          console.log(`   KEY: ${client.key_filename}`);
        }
        console.log("");
      });
    }

    // List sync-disabled clients
    if (syncDisabled.length > 0) {
      console.log("⏸️  SYNC DISABLED (Inactive):\n");
      syncDisabled.forEach((client, index) => {
        console.log(`${index + 1}. [ID: ${client.id}] ${client.business_name}`);
        console.log(`   RFC: ${client.tax_id || "N/A"}`);
        console.log(`   IDSE User: ${client.idse_user}`);
        console.log(`   Type: ${client.cert_type}`);
        console.log("");
      });
    }

  } catch (error) {
    console.error("❌ Database error:", error);
  } finally {
    const { endPool } = await import("./db");
    await endPool();
  }
}

// Export function to get a specific client's IDSE data
export async function getClientIDSE(clientId: number) {
  const clients = await listCompleteIDSEClients();
  return clients.find(c => c.id === clientId);
}

// Run if this file is executed directly
if (import.meta.main) {
  main();
}