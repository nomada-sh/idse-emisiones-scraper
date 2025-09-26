import { listCompleteIDSEClients } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import CertificateConverter from "./cert-to-pfx";
import { endPool } from "./db";
import { storePFX, clearAllPFX } from "./pfx-server";

interface EmisionData {
  registroPatronal: string;
  nombre: string;
  domicilio: string;
  actividad: string;
  mes: string;
  año: string;
  saldoEMA: string;
  saldoTotal: string;
}

/**
 * Extract emission data from JavaScript code in HTML
 */
function extractEmisionData(html: string): EmisionData[] {
  const emisiones: EmisionData[] = [];

  // Find all script blocks
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];

    // Check if this script contains the fillNumerosRegistros calls
    if (scriptContent.includes('fillNumerosRegistros')) {
      // Extract all the data using regex
      const registroRegex = /fillNumerosRegistros\("([^"]*)",\s*"([^"]*)"\)/g;
      const nombreRegex = /fillNombres\("([^"]*)",\s*"([^"]*)"\)/g;
      const domicilioRegex = /fillDomicilios\("([^"]*)",\s*"([^"]*)"\)/g;
      const actividadRegex = /fillActividades\("([^"]*)",\s*"([^"]*)"\)/g;
      const mesRegex = /fillMesNombre\("([^"]*)",\s*"([^"]*)"\)/g;
      const anoRegex = /fillAno\("([^"]*)",\s*"([^"]*)"\)/g;
      const saldoEMARegex = /fillSaldosEMA\("([^"]*)",\s*"([^"]*)"\)/g;
      const saldoTotalRegex = /fillSaldosTotal\("([^"]*)",\s*"([^"]*)"\)/g;

      // Extract values
      const registros = [...scriptContent.matchAll(registroRegex)];
      const nombres = [...scriptContent.matchAll(nombreRegex)];
      const domicilios = [...scriptContent.matchAll(domicilioRegex)];
      const actividades = [...scriptContent.matchAll(actividadRegex)];
      const meses = [...scriptContent.matchAll(mesRegex)];
      const anos = [...scriptContent.matchAll(anoRegex)];
      const saldosEMA = [...scriptContent.matchAll(saldoEMARegex)];
      const saldosTotal = [...scriptContent.matchAll(saldoTotalRegex)];

      // Build emission data for each registro
      for (let i = 0; i < registros.length; i++) {
        emisiones.push({
          registroPatronal: registros[i]?.[1] || '',
          nombre: nombres[i]?.[1] || '',
          domicilio: domicilios[i]?.[1] || '',
          actividad: actividades[i]?.[1] || '',
          mes: meses[0]?.[1] || '', // Usually the same for all
          año: anos[0]?.[1] || '',   // Usually the same for all
          saldoEMA: saldosEMA[i]?.[1] || '0.00',
          saldoTotal: saldosTotal[i]?.[1] || '0.00'
        });
      }
    }
  }

  return emisiones;
}

/**
 * Scrape emissions for a single client
 */
async function scrapeClientEmisiones(client: any) {
  try {
    // Step 1: Login
    let idseConnection: IDSEConnection;

    if (client.cert_type === 'PFX') {
      idseConnection = new IDSEConnection(
        client.idse_user,
        client.idse_password,
        client.pfx_url
      );
    } else if (client.cert_type === 'CER+KEY') {
      const pfxBuffer = await CertificateConverter.convertFromUrls(
        client.cer_url,
        client.key_url,
        client.idse_password
      );
      const tempPfxUrl = storePFX(`pfx_${client.id}_${Date.now()}`, pfxBuffer);
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

    // Step 2: Navigate to Emisión
    const cookies = (idseConnection as any).cookies;

    const emisionResponse = await fetch('https://idse.imss.gob.mx/imss/Modulos.idse?irA=emision', {
      method: 'POST',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': 'https://idse.imss.gob.mx',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://idse.imss.gob.mx/imss/AccesoIDSE.idse',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies
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

    const emisionHtml = await emisionResponse.text();

    // Step 3: Extract data from JavaScript
    const emisiones = extractEmisionData(emisionHtml);

    return {
      success: true,
      client: client.business_name,
      rfc: client.tax_id,
      emisiones
    };

  } catch (error) {
    return {
      success: false,
      client: client.business_name,
      rfc: client.tax_id,
      error: error instanceof Error ? error.message : String(error),
      emisiones: []
    };
  }
}

/**
 * Main function
 */
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("                    IDSE EMISIONES DATA EXTRACTOR");
  console.log("═══════════════════════════════════════════════════════════════\n");

  try {
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("❌ No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients to process\n`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];

      process.stdout.write(`[${i + 1}/${clients.length}] ${client.business_name.padEnd(40)} ... `);

      const result = await scrapeClientEmisiones(client);
      results.push(result);

      if (result.success) {
        successCount++;
        console.log(`✅ ${result.emisiones.length} registros`);
      } else {
        failCount++;
        // Simplify error messages
        let errorMsg = result.error || 'Error desconocido';
        if (errorMsg.includes('Only 8, 16, 24, or 32 bits supported')) {
          errorMsg = 'Certificado corrupto';
        } else if (errorMsg.includes('ShroudedKeyBag, wrong password')) {
          errorMsg = 'Contraseña incorrecta';
        } else if (errorMsg.includes('Cannot decrypt private key')) {
          errorMsg = 'No se puede desencriptar llave privada';
        } else if (errorMsg.includes('Cannot read X.509')) {
          errorMsg = 'Certificado inválido';
        } else if (errorMsg.includes('Cannot read private key')) {
          errorMsg = 'Llave privada inválida';
        }
        console.log(`❌ ${errorMsg}`);
      }

      // Small delay between clients
      if (i < clients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Print detailed results
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("                           RESULTS");
    console.log("═══════════════════════════════════════════════════════════════\n");

    console.log(`Summary: ✅ ${successCount} successful | ❌ ${failCount} failed\n`);

    // Print emission data for successful clients
    for (const result of results) {
      if (result.success && result.emisiones.length > 0) {
        console.log(`\n╔══════════════════════════════════════════════════════════════`);
        console.log(`║ ${result.client} (RFC: ${result.rfc})`);
        console.log(`╚══════════════════════════════════════════════════════════════`);

        for (const emision of result.emisiones) {
          console.log(`\n  📋 Registro Patronal: ${emision.registroPatronal}`);
          console.log(`     Nombre: ${emision.nombre}`);
          console.log(`     Domicilio: ${emision.domicilio}`);
          console.log(`     Actividad: ${emision.actividad}`);
          console.log(`     Período: ${emision.mes} ${emision.año}`);
          console.log(`     ├─ Saldo Cuota Mensual: $ ${emision.saldoEMA}`);
          console.log(`     └─ Saldo Total: $ ${emision.saldoTotal}`);
        }
      }
    }

    // List clients with no data
    const noDataClients = results.filter(r => r.success && r.emisiones.length === 0);
    if (noDataClients.length > 0) {
      console.log("\n⚠️  Clients with no emission data:");
      for (const client of noDataClients) {
        console.log(`   - ${client.client}`);
      }
    }

    // Save to JSON
    const fs = await import('fs');
    const outputFile = `emisiones_${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Data saved to: ${outputFile}`);

  } catch (error) {
    console.error("❌ Script failed");
  } finally {
    clearAllPFX();
    await endPool();
  }
}

// Run if executed directly
if (import.meta.main) {
  console.log('Starting PFX server...');
  await import('./pfx-server');
  await new Promise(resolve => setTimeout(resolve, 1000));

  main();
}