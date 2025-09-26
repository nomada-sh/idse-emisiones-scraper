import { listCompleteIDSEClients } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import CertificateConverter from "./cert-to-pfx";
import { endPool } from "./db";
import { storePFX, clearAllPFX } from "./pfx-server";
import * as cheerio from 'cheerio';

interface DescargaInfo {
  periodo: string;
  tipoEmision: string;
  formato: string;
  estatus: string;
  tamano?: string;
  tipoDescarga?: string;
}

interface PatronDescargas {
  registroPatronal: string;
  nombre: string;
  domicilio: string;
  actividad: string;
  descargas: DescargaInfo[];
}

interface ClientResult {
  clientId: number;
  clientName: string;
  rfc: string;
  patrones: PatronDescargas[];
  status: 'SUCCESS' | 'FAILED' | 'ERROR';
  error?: string;
}

/**
 * Extract patron codes from emission page
 */
function extractPatronesFromEmisionPage(html: string): string[] {
  const patrones: string[] = [];

  // Extract from JavaScript fillNumerosRegistros calls
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];

    if (scriptContent.includes('fillNumerosRegistros')) {
      const registroRegex = /fillNumerosRegistros\("([^"]*)",\s*"([^"]*)"\)/g;
      const registros = [...scriptContent.matchAll(registroRegex)];

      registros.forEach(r => {
        if (r[1] && !patrones.includes(r[1])) {
          patrones.push(r[1]);
        }
      });
    }
  }

  return patrones;
}

/**
 * Get download table for a specific patron
 */
async function getPatronDescargas(
  patron: string,
  cookies: string
): Promise<PatronDescargas | null> {
  try {
    // Step 1: ConsultaEmision with the patron
    const consultaUrl = `https://idse.imss.gob.mx/imss/ConsultaEmision.idse?patronConsulta=${patron}&consultarEmisiones=Consultar`;

    const consultaResponse = await fetch(consultaUrl, {
      method: 'GET',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://idse.imss.gob.mx/imss/Modulos.idse?irA=emision',
        'Cookie': cookies
      }
    });

    if (!consultaResponse.ok) {
      console.log(`     ❌ Failed to query patron ${patron}: ${consultaResponse.status}`);
      return null;
    }

    // Step 2: VerificaDescarga to get the download table
    const verificaResponse = await fetch('https://idse.imss.gob.mx/imss/VerificaDescarga.idse', {
      method: 'POST',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': 'https://idse.imss.gob.mx',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': consultaUrl,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies
      },
      body: new URLSearchParams({
        'periodo_anual_eba': '2025',
        'periodo_mensual_eba': '8',
        'periodo_mensual': '8',
        'periodo_anual': '2025'
      })
    });

    if (!verificaResponse.ok) {
      console.log(`     ❌ Failed to get downloads for patron ${patron}: ${verificaResponse.status}`);
      return null;
    }

    const html = await verificaResponse.text();
    const $ = cheerio.load(html);

    // Extract patron info
    const patronInfo: PatronDescargas = {
      registroPatronal: patron,
      nombre: '',
      domicilio: '',
      actividad: '',
      descargas: []
    };

    // Extract patron details
    $('div.row').each((_, row) => {
      const label = $(row).find('label').first().text().trim();
      const value = $(row).find('div.col-sm-5').text().trim();

      if (label.includes('Nombre') || label.includes('razón social')) {
        patronInfo.nombre = value;
      } else if (label.includes('Domicilio')) {
        patronInfo.domicilio = value;
      } else if (label.includes('Actividad')) {
        patronInfo.actividad = value;
      }
    });

    // Extract download table
    $('table.table-striped tr').each((index, row) => {
      if (index === 0) return; // Skip header

      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();

      if (cells.length >= 4) {
        const descarga: DescargaInfo = {
          periodo: cells[0],
          tipoEmision: cells[1],
          formato: cells[2],
          estatus: cells[3]
        };

        // Extract download size if available
        const linkText = $(row).find('a').text();
        const sizeMatch = linkText.match(/\((\d+\s*KB)\)/);
        if (sizeMatch) {
          descarga.tamano = sizeMatch[1];
        }

        // Extract tipo descarga from onclick
        const onclickAttr = $(row).find('a').attr('onclick') ||
                           $(row).find('button').attr('onclick') || '';
        const tipoMatch = onclickAttr.match(/descargarArchivo\('([^']+)'\)|iniciarDescarga\('([^']+)'\)/);
        if (tipoMatch) {
          descarga.tipoDescarga = tipoMatch[1] || tipoMatch[2];
        }

        patronInfo.descargas.push(descarga);
      }
    });

    return patronInfo;

  } catch (error) {
    console.log(`     ❌ Error getting downloads for patron ${patron}:`, error);
    return null;
  }
}

/**
 * Process client to get all download tables
 */
async function processClient(client: any): Promise<ClientResult> {
  const result: ClientResult = {
    clientId: client.id,
    clientName: client.business_name,
    rfc: client.tax_id || 'N/A',
    patrones: [],
    status: 'ERROR'
  };

  try {
    // Login
    let idseConnection: IDSEConnection;

    if (client.cert_type === 'PFX') {
      idseConnection = new IDSEConnection(
        client.idse_user,
        client.idse_password,
        client.pfx_url,
        false // no verbose
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
        tempPfxUrl,
        false
      );
    } else {
      throw new Error('Unknown certificate type');
    }

    const loginSuccess = await idseConnection.login();
    if (!loginSuccess) {
      throw new Error('Login failed');
    }

    const cookies = (idseConnection as any).cookies;

    // Navigate to Emisión
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

    // Extract patrones from the page
    const patrones = extractPatronesFromEmisionPage(emisionHtml);

    if (patrones.length === 0) {
      result.status = 'SUCCESS';
      return result; // No patrones found
    }

    // Get download info for each patron
    for (const patron of patrones) {
      const patronDescargas = await getPatronDescargas(patron, cookies);
      if (patronDescargas) {
        result.patrones.push(patronDescargas);
      }
    }

    result.status = 'SUCCESS';

  } catch (error) {
    result.status = 'ERROR';
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

/**
 * Main function
 */
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("                  IDSE DESCARGAS DISPONIBLES");
  console.log("═══════════════════════════════════════════════════════════════\n");

  try {
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("❌ No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients to process\n`);

    const results: ClientResult[] = [];

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];

      process.stdout.write(`[${i + 1}/${clients.length}] ${client.business_name.padEnd(40)} ... `);

      const result = await processClient(client);
      results.push(result);

      if (result.status === 'SUCCESS') {
        console.log(`✅ ${result.patrones.length} patrones`);
      } else {
        console.log(`❌ ${result.error}`);
      }

      // Delay between clients
      if (i < clients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Print results
    console.log("\n\n═══════════════════════════════════════════════════════════════");
    console.log("                         DESCARGAS DISPONIBLES");
    console.log("═══════════════════════════════════════════════════════════════\n");

    for (const result of results) {
      if (result.status === 'SUCCESS' && result.patrones.length > 0) {
        console.log(`\n╔══════════════════════════════════════════════════════════════`);
        console.log(`║ ${result.clientName} (RFC: ${result.rfc})`);
        console.log(`╚══════════════════════════════════════════════════════════════`);

        for (const patron of result.patrones) {
          console.log(`\n📋 Registro Patronal: ${patron.registroPatronal}`);
          console.log(`   Nombre: ${patron.nombre}`);
          console.log(`   Domicilio: ${patron.domicilio}`);
          console.log(`   Actividad: ${patron.actividad}`);

          if (patron.descargas.length > 0) {
            console.log(`\n   Descargas disponibles:`);
            console.log(`   ${"Periodo".padEnd(10)} | ${"Tipo".padEnd(35)} | ${"Formato".padEnd(8)} | ${"Estatus".padEnd(20)} | ${"Tamaño".padEnd(10)}`);
            console.log(`   ${"-".repeat(95)}`);

            for (const descarga of patron.descargas) {
              const tipo = descarga.tipoEmision.length > 35
                ? descarga.tipoEmision.substring(0, 32) + '...'
                : descarga.tipoEmision;
              console.log(`   ${descarga.periodo.padEnd(10)} | ${tipo.padEnd(35)} | ${descarga.formato.padEnd(8)} | ${descarga.estatus.padEnd(20)} | ${descarga.tamano || '-'.padEnd(10)}`);
            }
          }
        }
      }
    }

    // Save to JSON
    const fs = await import('fs');
    const outputFile = `descargas_disponibles_${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n\n💾 Data saved to: ${outputFile}`);

  } catch (error) {
    console.error("❌ Fatal error:", error);
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