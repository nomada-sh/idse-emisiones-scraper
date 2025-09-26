import { query, endPool } from "./db";
import forge from 'node-forge';

async function testCertificateFormats() {
  console.log("\n=== Testing Certificate Formats ===\n");

  try {
    // Get clients with CER+KEY that are failing
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
      WHERE c.business_name IN (
        'ARA SPRINGS',
        'JOSE ANTONIO LOBATO CRUZ',
        'PAYJOB PRUEBA (CIOBERAL)'
      )
      LIMIT 3
    `;

    const clients = await query(sql);
    console.log(`Found ${clients.length} clients with CER+KEY to test\n`);

    for (const client of clients) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Testing: ${client.business_name}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Test CER file
      console.log(`\n📜 CER File: ${client.cer_filename}`);
      try {
        const cerResponse = await fetch(client.cer_url);
        const cerBuffer = Buffer.from(await cerResponse.arrayBuffer());

        console.log(`   Size: ${cerBuffer.length} bytes`);

        // Check if it's base64 encoded
        const cerString = cerBuffer.toString('utf8');
        const isPEM = cerString.includes('-----BEGIN');
        const isBase64 = !isPEM && /^[A-Za-z0-9+/=]+$/.test(cerString.trim());

        console.log(`   Format: ${isPEM ? 'PEM' : isBase64 ? 'Base64' : 'Binary/DER'}`);

        // Try to parse it
        let certificate;
        try {
          if (isPEM) {
            certificate = forge.pki.certificateFromPem(cerString);
            console.log(`   ✅ Successfully parsed as PEM`);
          } else if (isBase64) {
            // Try to decode base64 first
            const decoded = Buffer.from(cerString.trim(), 'base64');
            const asn1 = forge.asn1.fromDer(decoded.toString('binary'));
            certificate = forge.pki.certificateFromAsn1(asn1);
            console.log(`   ✅ Successfully parsed as Base64-encoded DER`);
          } else {
            // Try as raw DER
            const asn1 = forge.asn1.fromDer(cerBuffer.toString('binary'));
            certificate = forge.pki.certificateFromAsn1(asn1);
            console.log(`   ✅ Successfully parsed as DER`);
          }

          // Print certificate info
          const subject = certificate.subject.attributes.map(attr =>
            `${attr.shortName}=${attr.value}`
          ).join(', ');
          console.log(`   Subject: ${subject}`);

        } catch (parseError: any) {
          console.log(`   ❌ Parse error: ${parseError.message}`);

          // Show first few bytes to understand format
          const preview = cerBuffer.slice(0, 50);
          console.log(`   First bytes (hex): ${preview.toString('hex').substring(0, 100)}`);
          console.log(`   First bytes (text): ${preview.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);
        }

      } catch (error: any) {
        console.log(`   ❌ Fetch error: ${error.message}`);
      }

      // Test KEY file
      console.log(`\n🔑 KEY File: ${client.key_filename}`);
      try {
        const keyResponse = await fetch(client.key_url);
        const keyBuffer = Buffer.from(await keyResponse.arrayBuffer());

        console.log(`   Size: ${keyBuffer.length} bytes`);

        // Check if it's base64 encoded
        const keyString = keyBuffer.toString('utf8');
        const isPEM = keyString.includes('-----BEGIN');
        const isBase64 = !isPEM && /^[A-Za-z0-9+/=]+$/.test(keyString.trim());

        console.log(`   Format: ${isPEM ? 'PEM' : isBase64 ? 'Base64' : 'Binary/DER'}`);

        // Try to parse it
        let privateKey;
        try {
          if (isPEM) {
            privateKey = forge.pki.privateKeyFromPem(keyString);
            console.log(`   ✅ Successfully parsed as PEM`);
          } else if (isBase64) {
            // Try to decode base64 first
            const decoded = Buffer.from(keyString.trim(), 'base64');
            const asn1 = forge.asn1.fromDer(decoded.toString('binary'));
            privateKey = forge.pki.privateKeyFromAsn1(asn1);
            console.log(`   ✅ Successfully parsed as Base64-encoded DER`);
          } else {
            // Try as raw DER
            const asn1 = forge.asn1.fromDer(keyBuffer.toString('binary'));
            privateKey = forge.pki.privateKeyFromAsn1(asn1);
            console.log(`   ✅ Successfully parsed as DER`);
          }

          console.log(`   Key type: RSA ${(privateKey as any).n.bitLength()} bits`);

        } catch (parseError: any) {
          console.log(`   ❌ Parse error: ${parseError.message}`);

          // Show first few bytes to understand format
          const preview = keyBuffer.slice(0, 50);
          console.log(`   First bytes (hex): ${preview.toString('hex').substring(0, 100)}`);
          console.log(`   First bytes (text): ${preview.toString('utf8').replace(/[^\x20-\x7E]/g, '.')}`);
        }

      } catch (error: any) {
        console.log(`   ❌ Fetch error: ${error.message}`);
      }
    }

  } catch (error) {
    console.error("Database error:", error);
  } finally {
    await endPool();
  }
}

// Run
if (import.meta.main) {
  testCertificateFormats();
}