import { listCompleteIDSEClients } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import CertificateConverter from "./cert-to-pfx";
import { endPool, query } from "./db";
import { storePFX, clearAllPFX } from "./pfx-server";
import * as cheerio from 'cheerio';

interface EmisionData {
  mes: string;
  saldoTotal: string;
  saldoCuotaMensual: string;
  saldoCuotaBimestral: string;
}

interface ClientEmisionResult {
  clientId: number;
  clientName: string;
  rfc: string;
  patrones: PatronEmision[];
  status: 'SUCCESS' | 'FAILED' | 'ERROR';
  error?: string;
}

interface PatronEmision {
  registroPatronal: string;
  emisiones: EmisionData[];
  error?: string;
}

/**
 * Get patrones (registro patronal) for a client
 */
async function getClientPatrones(clientId: number): Promise<string[]> {
  const sql = `
    SELECT DISTINCT crp.registro_patronal
    FROM client_registros_patronales crp
    INNER JOIN client_registros_patronales_client_links crpl
      ON crp.id = crpl.client_registro_patronal_id
    WHERE crpl.client_id = $1
    AND crp.registro_patronal IS NOT NULL
    ORDER BY crp.registro_patronal
  `;

  try {
    const results = await query(sql, [clientId]);
    return results.map(r => r.registro_patronal);
  } catch (error) {
    console.error(`Error fetching patrones for client ${clientId}:`, error);
    // Try fallback to imss_employer_registration field
    try {
      const fallbackSql = `
        SELECT imss_employer_registration as registro_patronal
        FROM clients
        WHERE id = $1
        AND imss_employer_registration IS NOT NULL
      `;
      const fallbackResults = await query(fallbackSql, [clientId]);
      if (fallbackResults.length > 0 && fallbackResults[0].registro_patronal) {
        return [fallbackResults[0].registro_patronal];
      }
    } catch (fallbackError) {
      console.error(`Fallback also failed for client ${clientId}:`, fallbackError);
    }
    return [];
  }
}

/**
 * Parse emission table from HTML
 */
function parseEmisionTable(html: string): EmisionData[] {
  const $ = cheerio.load(html);
  const emisiones: EmisionData[] = [];

  // Look for tables with the emission headers in <td> tags with <b> (not <th>)
  $('table').each((_, table) => {
    let isEmisionTable = false;
    let headerRowFound = false;

    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
      const boldCells = $(row).find('td b').map((_, b) => $(b).text().trim()).get();

      // Check if this row contains the headers (in bold)
      if (boldCells.some(text => text.includes('Emisión mensual') || text.includes('Emisi\u00F3n mensual'))) {
        isEmisionTable = true;
        headerRowFound = true;
        return; // Skip header row
      }

      // If we found the emissions table and this is a data row
      if (isEmisionTable && cells.length >= 5) {
        // Skip the header row and empty rows
        if (headerRowFound && cells[1] && !cells[1].includes('Emisión') && !cells[1].includes('Emisi\u00F3n')) {
          // First cell is usually empty, actual data starts from index 1
          if (cells[1].match(/\w+\s+\d{4}/)) { // Check if it looks like "Month Year"
            emisiones.push({
              mes: cells[1],
              saldoTotal: cells[2],
              saldoCuotaMensual: cells[3],
              saldoCuotaBimestral: cells[4]
            });
          }
        }
      }
    });
  });

  // Alternative: Try with table.table-striped specifically
  if (emisiones.length === 0) {
    $('table.table-striped tr').each((i, row) => {
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();

      // Skip header row and check data rows
      if (cells.length >= 5 && i > 0) {
        if (cells[1] && cells[1].match(/\w+\s+\d{4}/)) {
          emisiones.push({
            mes: cells[1],
            saldoTotal: cells[2],
            saldoCuotaMensual: cells[3],
            saldoCuotaBimestral: cells[4]
          });
        }
      }
    });
  }

  return emisiones;
}

/**
 * Scrape emissions for a single client
 */
async function scrapeClientEmisiones(client: any): Promise<ClientEmisionResult> {
  const result: ClientEmisionResult = {
    clientId: client.id,
    clientName: client.business_name,
    rfc: client.tax_id || 'N/A',
    patrones: [],
    status: 'ERROR'
  };

  try {
    // Step 1: Login to IDSE
    console.log(`\n🔐 Logging in for ${client.business_name}...`);

    let idseConnection: IDSEConnection;
    let tempPfxId: string | null = null;

    // Handle different certificate types
    if (client.cert_type === 'PFX') {
      idseConnection = new IDSEConnection(
        client.idse_user,
        client.idse_password,
        client.pfx_url
      );
    } else if (client.cert_type === 'CER+KEY') {
      console.log(`   Converting CER+KEY to PFX...`);
      const pfxBuffer = await CertificateConverter.convertFromUrls(
        client.cer_url,
        client.key_url,
        client.idse_password
      );
      tempPfxId = `pfx_${client.id}_${Date.now()}`;
      const tempPfxUrl = storePFX(tempPfxId, pfxBuffer);
      idseConnection = new IDSEConnection(
        client.idse_user,
        client.idse_password,
        tempPfxUrl
      );
    } else {
      throw new Error('Unknown certificate type');
    }

    const loginSuccess = await idseConnection.login();

    if (!loginSuccess) {
      throw new Error('Login failed');
    }

    console.log(`   ✅ Login successful`);

    // Step 2: Navigate to Emisión module
    console.log(`   📊 Navigating to Emisión module...`);

    const emisionResponse = await fetch('https://idse.imss.gob.mx/imss/Modulos.idse?irA=emision', {
      method: 'POST',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': 'https://idse.imss.gob.mx',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://idse.imss.gob.mx/imss/AccesoIDSE.idse',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': (idseConnection as any).cookies || ''
      },
      body: new URLSearchParams({
        'irA': '',
        'idUsuario': client.idse_user,
        'rfc_fiel': client.tax_id || ''
      })
    });

    if (!emisionResponse.ok) {
      throw new Error(`Failed to navigate to Emisión: ${emisionResponse.status}`);
    }

    // Step 3: Get patrones for this client
    const patrones = await getClientPatrones(client.id);
    console.log(`   📋 Found ${patrones.length} patrones for this client`);

    if (patrones.length === 0) {
      console.log(`   ⚠️ No patrones found in database, trying default patron`);
      // Try with a default patron if available from client data
      if (client.registro_patronal) {
        patrones.push(client.registro_patronal);
      }
    }

    // Step 4: Query emissions for each patron
    for (const patron of patrones) {
      console.log(`   🔍 Querying emissions for patron: ${patron}`);

      try {
        const consultaUrl = `https://idse.imss.gob.mx/imss/ConsultaEmision.idse?patronConsulta=${patron}&consultarEmisiones=Consultar`;

        const consultaResponse = await fetch(consultaUrl, {
          method: 'GET',
          headers: {
            'Host': 'idse.imss.gob.mx',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Referer': 'https://idse.imss.gob.mx/imss/Modulos.idse?irA=emision',
            'Cookie': (idseConnection as any).cookies || ''
          }
        });

        if (!consultaResponse.ok) {
          console.log(`     ❌ Failed to query patron ${patron}: ${consultaResponse.status}`);
          result.patrones.push({
            registroPatronal: patron,
            emisiones: [],
            error: `HTTP ${consultaResponse.status}`
          });
          continue;
        }

        const html = await consultaResponse.text();

        // Parse the emissions table
        const emisiones = parseEmisionTable(html);

        if (emisiones.length > 0) {
          console.log(`     ✅ Found ${emisiones.length} emission records`);
          emisiones.forEach(e => {
            console.log(`        ${e.mes}: Total=${e.saldoTotal}, Mensual=${e.saldoCuotaMensual}, Bimestral=${e.saldoCuotaBimestral}`);
          });

          result.patrones.push({
            registroPatronal: patron,
            emisiones: emisiones
          });
        } else {
          console.log(`     ⚠️ No emissions found for patron ${patron}`);
          result.patrones.push({
            registroPatronal: patron,
            emisiones: [],
            error: 'No emissions in table'
          });
        }

      } catch (patronError) {
        console.log(`     ❌ Error querying patron ${patron}:`, patronError);
        result.patrones.push({
          registroPatronal: patron,
          emisiones: [],
          error: String(patronError)
        });
      }
    }

    result.status = 'SUCCESS';

    // Clean up temporary PFX if created
    if (tempPfxId) {
      // Remove from server after use
      // Note: removePFX is not exposed, so we'll let it clean up automatically
    }

  } catch (error) {
    console.error(`   ❌ Error for client ${client.business_name}:`, error);
    result.status = 'ERROR';
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Main function to scrape all emissions
 */
async function scrapeAllEmisiones() {
  console.log("\n=== IDSE Emisiones Scraper ===\n");

  try {
    // Get all complete clients
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients to process\n`);

    const results: ClientEmisionResult[] = [];

    // Process each client
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      console.log(`\n[${i + 1}/${clients.length}] Processing: ${client.business_name}`);
      console.log(`   RFC: ${client.tax_id || 'N/A'}`);
      console.log(`   IDSE User: ${client.idse_user}`);

      const result = await scrapeClientEmisiones(client);
      results.push(result);

      // Add a small delay between clients to avoid rate limiting
      if (i < clients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Print summary
    console.log("\n\n📊 SUMMARY:\n");
    console.log("=" .repeat(80));

    const successful = results.filter(r => r.status === 'SUCCESS');
    const failed = results.filter(r => r.status !== 'SUCCESS');

    console.log(`✅ Successful: ${successful.length}`);
    console.log(`❌ Failed: ${failed.length}`);

    console.log("\n📈 EMISSION DATA:\n");
    console.log("=" .repeat(80));

    for (const result of successful) {
      console.log(`\n${result.clientName} (RFC: ${result.rfc})`);

      for (const patron of result.patrones) {
        if (patron.emisiones.length > 0) {
          console.log(`  Patrón: ${patron.registroPatronal}`);
          console.log(`  ${"Mes".padEnd(20)} | ${"Total".padEnd(15)} | ${"Mensual".padEnd(15)} | ${"Bimestral".padEnd(15)}`);
          console.log(`  ${"-".repeat(70)}`);

          for (const emision of patron.emisiones) {
            console.log(`  ${emision.mes.padEnd(20)} | ${emision.saldoTotal.padEnd(15)} | ${emision.saldoCuotaMensual.padEnd(15)} | ${emision.saldoCuotaBimestral.padEnd(15)}`);
          }
        } else {
          console.log(`  Patrón: ${patron.registroPatronal} - No emissions found`);
        }
      }
    }

    if (failed.length > 0) {
      console.log("\n\n❌ FAILED CLIENTS:\n");
      console.log("=" .repeat(80));

      for (const result of failed) {
        console.log(`${result.clientName}: ${result.error}`);
      }
    }

    // Export results to JSON
    const fs = await import('fs');
    const outputPath = 'emisiones-data.json';
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n💾 Results saved to ${outputPath}`);

  } catch (error) {
    console.error("❌ Fatal error:", error);
  } finally {
    clearAllPFX();
    await endPool();
  }
}

// Run if executed directly
if (import.meta.main) {
  console.log('Starting PFX server for CER+KEY clients...');
  console.log('Server will be available at http://localhost:8080\n');

  // Import the server to start it
  await import('./pfx-server');

  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  scrapeAllEmisiones();
}