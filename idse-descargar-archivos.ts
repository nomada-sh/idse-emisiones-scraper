import { listCompleteIDSEClients } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import CertificateConverter from "./cert-to-pfx";
import { endPool } from "./db";
import { storePFX, clearAllPFX } from "./pfx-server";
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

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
  descargas: DescargaInfo[];
}

/**
 * Extract patron codes from emission page
 */
function extractPatronesFromEmisionPage(html: string): string[] {
  const patrones: string[] = [];
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
 * Generate filename for download
 */
function generateFileName(
  patron: string,
  tipoDescarga: string,
  periodo: string,
  tipoEmision: string,
  formato: string,
  actualExtension?: string
): string {
  // Clean patron for filename
  const cleanPatron = patron.replace(/[^a-zA-Z0-9]/g, '');

  // Extract month and year from periodo (e.g., "8/2025")
  const [mes, anio] = periodo.split('/');

  // Determine base name (EMA or EBA)
  const baseName = tipoEmision.includes('mensual') ? 'EMA' : 'EBA';

  // Use actual extension if provided, otherwise determine from tipoDescarga
  let extension = actualExtension || '.pdf';
  if (!actualExtension) {
    if (tipoDescarga.includes('EXCEL')) {
      extension = '.xlsx';
    } else if (tipoDescarga.includes('SUA')) {
      extension = '.sua';
    } else if (tipoDescarga === 'EMA' || tipoDescarga === 'EBA') {
      extension = '.vis';
    } else if (tipoDescarga.includes('PDF')) {
      extension = '.pdf';
    }
  }

  // Format: PATRON_EMA_2025_08_PDF.pdf
  return `${cleanPatron}_${baseName}_${anio}_${mes.padStart(2, '0')}_${formato.toUpperCase()}${extension}`;
}

/**
 * Download a single file
 */
async function downloadFile(
  patron: string,
  descarga: DescargaInfo,
  cookies: string,
  outputDir: string
): Promise<boolean> {
  try {
    if (!descarga.tipoDescarga) {
      console.log(`        ⏭️ No tipo descarga for ${descarga.formato}`);
      return false;
    }

    const response = await fetch('https://idse.imss.gob.mx/imss/EmisionDescarga.idse', {
      method: 'POST',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': 'https://idse.imss.gob.mx',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://idse.imss.gob.mx/imss/VerificaDescarga.idse',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies
      },
      body: new URLSearchParams({
        'TIPODESCARGA': descarga.tipoDescarga,
        'periodo_mensual': descarga.periodo.split('/')[0],
        'periodo_anual': descarga.periodo.split('/')[1],
        'patronConsulta': patron
      })
    });

    if (!response.ok) {
      console.log(`        ❌ Download failed: HTTP ${response.status}`);
      return false;
    }

    // Get the binary data
    const buffer = Buffer.from(await response.arrayBuffer());

    // Check if it's a ZIP file
    if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
      // It's a ZIP file, extract the content
      try {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        if (entries.length > 0) {
          const entry = entries[0]; // Get first file from ZIP
          const extractedBuffer = entry.getData();
          const extractedName = entry.entryName;

          // Get actual extension from extracted file
          const actualExtension = path.extname(extractedName);

          // Generate filename with actual extension
          const filename = generateFileName(
            patron,
            descarga.tipoDescarga,
            descarga.periodo,
            descarga.tipoEmision,
            descarga.formato,
            actualExtension
          );

          // Save extracted file
          const filePath = path.join(outputDir, filename);
          fs.writeFileSync(filePath, extractedBuffer);

          console.log(`        ✅ Downloaded & extracted: ${filename} (${extractedBuffer.length} bytes from ZIP)`);
          return true;
        }
      } catch (zipError) {
        console.log(`        ⚠️ ZIP extraction failed, saving as-is`);
      }
    }

    // Not a ZIP or extraction failed, save as-is
    const filename = generateFileName(
      patron,
      descarga.tipoDescarga,
      descarga.periodo,
      descarga.tipoEmision,
      descarga.formato
    );

    // Save file
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, buffer);

    console.log(`        ✅ Downloaded: ${filename} (${buffer.length} bytes)`);
    return true;

  } catch (error) {
    console.log(`        ❌ Error downloading:`, error);
    return false;
  }
}

/**
 * Process downloads for a patron
 */
async function processPatronDownloads(
  patron: string,
  cookies: string,
  outputDir: string
): Promise<{ patron: string; downloads: number }> {
  try {
    // Step 1: ConsultaEmision
    const consultaUrl = `https://idse.imss.gob.mx/imss/ConsultaEmision.idse?patronConsulta=${patron}&consultarEmisiones=Consultar`;

    await fetch(consultaUrl, {
      method: 'GET',
      headers: {
        'Host': 'idse.imss.gob.mx',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://idse.imss.gob.mx/imss/Modulos.idse?irA=emision',
        'Cookie': cookies
      }
    });

    // Step 2: VerificaDescarga
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
      console.log(`     ❌ Failed to get downloads page for patron ${patron}`);
      return { patron, downloads: 0 };
    }

    const html = await verificaResponse.text();
    const $ = cheerio.load(html);

    const descargas: DescargaInfo[] = [];

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

        // Extract tipo descarga from onclick or href
        const linkElement = $(row).find('a');
        const onclickAttr = linkElement.attr('onclick') || '';
        const hrefAttr = linkElement.attr('href') || '';

        // Try onclick first, then href
        let tipoMatch = onclickAttr.match(/descargarArchivo\('([^']+)'\)/);
        if (!tipoMatch) {
          tipoMatch = hrefAttr.match(/descargarArchivo\('([^']+)'\)/);
        }

        if (tipoMatch) {
          descarga.tipoDescarga = tipoMatch[1];
        }

        // Only add if file is ready (Archivo generado)
        if (descarga.estatus === 'Archivo generado' && descarga.tipoDescarga) {
          descargas.push(descarga);
        }
      }
    });

    console.log(`     📋 Patron ${patron}: ${descargas.length} files available`);

    // Download each available file
    let downloadCount = 0;
    for (const descarga of descargas) {
      const success = await downloadFile(patron, descarga, cookies, outputDir);
      if (success) downloadCount++;
    }

    return { patron, downloads: downloadCount };

  } catch (error) {
    console.log(`     ❌ Error processing patron ${patron}:`, error);
    return { patron, downloads: 0 };
  }
}

/**
 * Process client downloads
 */
async function processClient(client: any): Promise<{ client: string; totalDownloads: number; patrones: any[] }> {
  const outputDir = path.join('idse-downloads', client.tax_id || `client_${client.id}`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    // Login
    let idseConnection: IDSEConnection;

    if (client.cert_type === 'PFX') {
      idseConnection = new IDSEConnection(
        client.idse_user,
        client.idse_password,
        client.pfx_url,
        false
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

    // Extract patrones
    const patrones = extractPatronesFromEmisionPage(emisionHtml);

    if (patrones.length === 0) {
      console.log(`     ⚠️ No patrones found`);
      return { client: client.business_name, totalDownloads: 0, patrones: [] };
    }

    // Process each patron
    const patronResults = [];
    let totalDownloads = 0;

    for (const patron of patrones) {
      const result = await processPatronDownloads(patron, cookies, outputDir);
      patronResults.push(result);
      totalDownloads += result.downloads;
    }

    return {
      client: client.business_name,
      totalDownloads,
      patrones: patronResults
    };

  } catch (error) {
    console.log(`     ❌ Error:`, error);
    return {
      client: client.business_name,
      totalDownloads: 0,
      patrones: []
    };
  }
}

/**
 * Main function
 */
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("                    IDSE DESCARGA DE ARCHIVOS");
  console.log("═══════════════════════════════════════════════════════════════\n");

  try {
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("❌ No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients to process\n`);

    // Create main download directory
    if (!fs.existsSync('idse-downloads')) {
      fs.mkdirSync('idse-downloads');
    }

    const results = [];
    let totalFilesDownloaded = 0;

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];

      console.log(`\n[${i + 1}/${clients.length}] ${client.business_name}`);
      console.log(`     RFC: ${client.tax_id || 'N/A'}`);

      const result = await processClient(client);
      results.push(result);
      totalFilesDownloaded += result.totalDownloads;

      console.log(`     📦 Downloaded: ${result.totalDownloads} files`);

      // Delay between clients
      if (i < clients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Summary
    console.log("\n\n═══════════════════════════════════════════════════════════════");
    console.log("                           SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════\n");

    console.log(`✅ Total files downloaded: ${totalFilesDownloaded}`);
    console.log(`📁 Files saved in: ./idse-downloads/`);

    // List successful downloads
    const successfulClients = results.filter(r => r.totalDownloads > 0);
    if (successfulClients.length > 0) {
      console.log(`\n📥 Successful downloads:`);
      for (const result of successfulClients) {
        console.log(`   - ${result.client}: ${result.totalDownloads} files`);
        for (const patron of result.patrones) {
          if (patron.downloads > 0) {
            console.log(`     └─ ${patron.patron}: ${patron.downloads} files`);
          }
        }
      }
    }

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