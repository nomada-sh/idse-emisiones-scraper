import { query } from "./db";
import CertificateConverter from "./cert-to-pfx";

/**
 * Get clients that have CER+KEY but not PFX
 */
async function getClientsWithCerKey() {
  const sql = `
    SELECT
      c.id,
      c.business_name,
      c.idse_user,
      c.idse_password,
      cer.url as cer_url,
      cer.name as cer_filename,
      key.url as key_url,
      key.name as key_filename
    FROM clients c
    INNER JOIN (
      SELECT
        frm.related_id as client_id,
        f.url,
        f.name
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseCer'
    ) cer ON cer.client_id = c.id
    INNER JOIN (
      SELECT
        frm.related_id as client_id,
        f.url,
        f.name
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseKey'
    ) key ON key.client_id = c.id
    LEFT JOIN (
      SELECT
        frm.related_id as client_id,
        f.id
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      WHERE frm.related_type = 'api::client.client'
      AND frm.field = 'idseCerPFX'
    ) pfx ON pfx.client_id = c.id
    WHERE c.idse_password IS NOT NULL
    AND pfx.id IS NULL
    ORDER BY c.business_name
  `;

  return await query(sql);
}

/**
 * Convert a client's CER+KEY to PFX
 */
async function convertClientCertificates(client: any) {
  console.log(`\n🏢 Processing: ${client.business_name}`);
  console.log(`   CER: ${client.cer_filename}`);
  console.log(`   KEY: ${client.key_filename}`);

  try {
    // Convert URLs to PFX
    const pfxBuffer = await CertificateConverter.convertFromUrls(
      client.cer_url,
      client.key_url,
      client.idse_password
    );

    // Validate the PFX
    if (CertificateConverter.validatePfx(pfxBuffer, client.idse_password)) {
      console.log(`   ✅ Successfully converted to PFX (${pfxBuffer.length} bytes)`);
      return {
        success: true,
        clientId: client.id,
        clientName: client.business_name,
        pfxBuffer
      };
    } else {
      console.log(`   ❌ PFX validation failed`);
      return {
        success: false,
        clientId: client.id,
        clientName: client.business_name,
        error: 'PFX validation failed'
      };
    }
  } catch (error) {
    console.log(`   ❌ Conversion failed:`, error);
    return {
      success: false,
      clientId: client.id,
      clientName: client.business_name,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  console.log('\n=== CER+KEY to PFX Converter for Database ===\n');

  try {
    // Get clients with CER+KEY but no PFX
    const clients = await getClientsWithCerKey();

    if (clients.length === 0) {
      console.log('No clients found with CER+KEY (without PFX)');
      return;
    }

    console.log(`Found ${clients.length} clients with CER+KEY to convert:\n`);

    clients.forEach((client, index) => {
      console.log(`${index + 1}. ${client.business_name}`);
      console.log(`   User: ${client.idse_user}`);
      console.log(`   CER: ${client.cer_filename}`);
      console.log(`   KEY: ${client.key_filename}`);
      console.log('');
    });

    // Ask if user wants to convert
    console.log('Would you like to convert these to PFX format?\n');
    console.log('Note: This will create PFX files locally but not upload them to the database.');
    console.log('The generated PFX files can be manually uploaded to Strapi.\n');

    // Convert all clients
    const results = [];
    for (const client of clients) {
      const result = await convertClientCertificates(client);
      results.push(result);

      // Save successful conversions to local files
      if (result.success && result.pfxBuffer) {
        const filename = `${client.id}_${client.business_name.replace(/[^a-zA-Z0-9]/g, '_')}.pfx`;
        const fs = await import('fs');
        fs.writeFileSync(filename, result.pfxBuffer);
        console.log(`   💾 Saved to: ${filename}\n`);
      }
    }

    // Summary
    console.log('\n📊 CONVERSION SUMMARY:\n');
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`✅ Successful: ${successful.length}`);
    successful.forEach(r => {
      console.log(`   - ${r.clientName}`);
    });

    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      failed.forEach(r => {
        console.log(`   - ${r.clientName}: ${r.error}`);
      });
    }

    console.log('\n📁 Next Steps:');
    console.log('1. The PFX files have been saved in the current directory');
    console.log('2. Upload them to Strapi via the admin panel');
    console.log('3. Attach them to the respective clients as idseCerPFX');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    const { endPool } = await import('./db');
    await endPool();
  }
}

// Test conversion with a specific client
export async function testConversion(clientId: number) {
  try {
    const sql = `
      SELECT
        c.id,
        c.business_name,
        c.idse_user,
        c.idse_password,
        cer.url as cer_url,
        cer.name as cer_filename,
        key.url as key_url,
        key.name as key_filename
      FROM clients c
      INNER JOIN (
        SELECT
          frm.related_id as client_id,
          f.url,
          f.name
        FROM files f
        INNER JOIN files_related_morphs frm ON f.id = frm.file_id
        WHERE frm.related_type = 'api::client.client'
        AND frm.field = 'idseCer'
      ) cer ON cer.client_id = c.id
      INNER JOIN (
        SELECT
          frm.related_id as client_id,
          f.url,
          f.name
        FROM files f
        INNER JOIN files_related_morphs frm ON f.id = frm.file_id
        WHERE frm.related_type = 'api::client.client'
        AND frm.field = 'idseKey'
      ) key ON key.client_id = c.id
      WHERE c.id = $1
    `;

    const results = await query(sql, [clientId]);

    if (results.length === 0) {
      console.log('Client not found or missing CER/KEY files');
      return;
    }

    const client = results[0];
    console.log(`\n🧪 Testing conversion for: ${client.business_name}\n`);

    const result = await convertClientCertificates(client);

    if (result.success && result.pfxBuffer) {
      const filename = `test_${client.id}_${client.business_name.replace(/[^a-zA-Z0-9]/g, '_')}.pfx`;
      const fs = await import('fs');
      fs.writeFileSync(filename, result.pfxBuffer);
      console.log(`\n💾 Test PFX saved to: ${filename}`);
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    const { endPool } = await import('./db');
    await endPool();
  }
}

// Run if executed directly
if (import.meta.main) {
  // Check if a specific client ID was provided
  const clientId = process.argv[2];
  if (clientId && !isNaN(Number(clientId))) {
    testConversion(Number(clientId));
  } else {
    main();
  }
}