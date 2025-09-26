import { listCompleteIDSEClients } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import CertificateConverter from "./cert-to-pfx";
import { endPool } from "./db";
import fs from "fs";
import path from "path";
import { storePFX, clearAllPFX } from "./pfx-server";

/**
 * Create a safe folder name from RFC
 */
function createSafeFolderName(rfc: string | null, clientId: number, businessName: string): string {
  if (rfc && rfc !== 'N/A') {
    // Use RFC as folder name, remove special characters
    return rfc.replace(/[^a-zA-Z0-9]/g, '_');
  } else {
    // Fallback to ID and business name
    return `${clientId}_${businessName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }
}

/**
 * Ensure output directory exists
 */
function ensureOutputDir(): string {
  const outputDir = path.join(process.cwd(), 'idse-output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * Download certificates and save credentials
 */
async function downloadCertificates(client: any, folderPath: string) {
  try {
    console.log(`   📦 Downloading certificates and credentials...`);

    if (client.cert_type === 'PFX' && client.pfx_url) {
      // Download PFX file
      console.log(`     📥 Downloading PFX: ${client.pfx_filename}`);
      const pfxResponse = await fetch(client.pfx_url);
      if (pfxResponse.ok) {
        const pfxBuffer = Buffer.from(await pfxResponse.arrayBuffer());
        const pfxPath = path.join(folderPath, client.pfx_filename || 'certificate.pfx');
        fs.writeFileSync(pfxPath, pfxBuffer);
        console.log(`     ✅ PFX saved: ${client.pfx_filename}`);
      }
    } else if (client.cert_type === 'CER+KEY') {
      // Download CER file
      if (client.cer_url) {
        console.log(`     📥 Downloading CER: ${client.cer_filename}`);
        const cerResponse = await fetch(client.cer_url);
        if (cerResponse.ok) {
          const cerBuffer = Buffer.from(await cerResponse.arrayBuffer());
          const cerPath = path.join(folderPath, client.cer_filename || 'certificate.cer');
          fs.writeFileSync(cerPath, cerBuffer);
          console.log(`     ✅ CER saved: ${client.cer_filename}`);
        }
      }

      // Download KEY file
      if (client.key_url) {
        console.log(`     📥 Downloading KEY: ${client.key_filename}`);
        const keyResponse = await fetch(client.key_url);
        if (keyResponse.ok) {
          const keyBuffer = Buffer.from(await keyResponse.arrayBuffer());
          const keyPath = path.join(folderPath, client.key_filename || 'private.key');
          fs.writeFileSync(keyPath, keyBuffer);
          console.log(`     ✅ KEY saved: ${client.key_filename}`);
        }
      }
    }

    // Save credentials in a secure file
    const credsPath = path.join(folderPath, 'credentials.txt');
    const credsContent = `IDSE Credentials
================\nRFC: ${client.tax_id || 'N/A'}\nBusiness: ${client.business_name}\nIDSE User: ${client.idse_user}\nIDSE Password: ${client.idse_password}\nCertificate Type: ${client.cert_type}\n\nNote: Keep this file secure and do not share it.`;
    fs.writeFileSync(credsPath, credsContent);
    console.log(`     ✅ Credentials saved to credentials.txt`);

  } catch (error) {
    console.error(`     ❌ Error downloading certificates:`, error);
  }
}

/**
 * Test IDSE login for all complete clients
 */
async function testAllLogins() {
  console.log("\n=== Testing IDSE Login for All Clients ===\n");

  try {
    // Create main output directory
    const outputDir = ensureOutputDir();
    console.log(`📁 Output directory: ${outputDir}\n`);

    // Get all complete clients
    const clients = await listCompleteIDSEClients();

    if (clients.length === 0) {
      console.log("No clients with complete IDSE setup found");
      return;
    }

    console.log(`📊 Found ${clients.length} clients to test\n`);
    console.log("Starting login tests...\n");
    console.log("=" .repeat(80));

    const results: any[] = [];

    // Test each client
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      console.log(`\n[${i + 1}/${clients.length}] Testing: ${client.business_name}`);
      console.log(`   ID: ${client.id}`);
      console.log(`   RFC: ${client.tax_id || "N/A"}`);
      console.log(`   User: ${client.idse_user}`);
      console.log(`   Type: ${client.cert_type}`);

      // Create folder for this client
      const folderName = createSafeFolderName(client.tax_id, client.id, client.business_name);
      const clientFolder = path.join(outputDir, folderName);

      if (!fs.existsSync(clientFolder)) {
        fs.mkdirSync(clientFolder, { recursive: true });
      }

      console.log(`   📂 Folder: ${folderName}/`);

      try {
        let idseConnection: IDSEConnection;

        // Handle different certificate types
        if (client.cert_type === 'PFX') {
          console.log(`   Using PFX: ${client.pfx_filename}`);
          idseConnection = new IDSEConnection(
            client.idse_user,
            client.idse_password,
            client.pfx_url
          );
        } else if (client.cert_type === 'CER+KEY') {
          console.log(`   Converting CER+KEY to PFX...`);
          try {
            // Convert CER+KEY to PFX on the fly
            const pfxBuffer = await CertificateConverter.convertFromUrls(
              client.cer_url,
              client.key_url,
              client.idse_password
            );

            // Store PFX in temporary server and get URL
            const pfxId = `pfx_${client.id}_${Date.now()}`;
            const tempPfxUrl = storePFX(pfxId, pfxBuffer);
            console.log(`   Temporary PFX URL: ${tempPfxUrl}`);

            // Create IDSE connection with temporary URL
            idseConnection = new IDSEConnection(
              client.idse_user,
              client.idse_password,
              tempPfxUrl
            );
          } catch (conversionError) {
            console.log(`   ❌ Failed to convert CER+KEY: ${conversionError}`);

            // Create error file in folder
            const errorPath = path.join(clientFolder, 'error.txt');
            fs.writeFileSync(errorPath, `Client: ${client.business_name}
ID: ${client.id}
RFC: ${client.tax_id || 'N/A'}
Status: CER+KEY Conversion Failed
Error: ${conversionError}
Date: ${new Date().toISOString()}`);

            results.push({
              client: client.business_name,
              id: client.id,
              rfc: client.tax_id,
              folder: folderName,
              status: 'ERROR',
              error: `CER+KEY conversion failed: ${conversionError}`
            });
            continue;
          }
        } else {
          console.log(`   ❌ Unknown certificate type`);
          results.push({
            client: client.business_name,
            id: client.id,
            rfc: client.tax_id,
            folder: folderName,
            status: 'ERROR',
            error: 'Unknown certificate type'
          });
          continue;
        }

        console.log(`   Attempting login...`);
        const loginResult = await idseConnection.login();

        if (loginResult) {
          console.log(`   ✅ LOGIN SUCCESSFUL!`);

          // Save client info
          const infoPath = path.join(clientFolder, 'info.txt');
          fs.writeFileSync(infoPath, `Client: ${client.business_name}
ID: ${client.id}
RFC: ${client.tax_id || 'N/A'}
IDSE User: ${client.idse_user}
Certificate Type: ${client.cert_type}
Login Status: SUCCESS
Date: ${new Date().toISOString()}`);

          // Download certificates with passwords
          await downloadCertificates(client, clientFolder);

          // Fetch multiple pages
          const pagesToFetch = [
            { url: 'https://idse.imss.gob.mx/imss/Menu.idse', name: 'menu.html' },
            { url: 'https://idse.imss.gob.mx/imss/AfiliaResultados.idse', name: 'resultados.html' },
            { url: 'https://idse.imss.gob.mx/imss/Modulos.idse?irA=afiliacion', name: 'afiliacion.html' }
          ];

          for (const page of pagesToFetch) {
            try {
              console.log(`   Fetching ${page.name}...`);
              const response = await fetch(page.url, {
                method: page.name === 'resultados.html' ? 'POST' : 'GET',
                headers: {
                  'Cookie': (idseConnection as any).cookies || '',
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                },
                body: page.name === 'resultados.html' ?
                  new URLSearchParams({
                    loteID: '',
                    loteFecha: '',
                    act: 'encuesta',
                    paginacion: '10'
                  }) : undefined
              });

              const html = await response.text();
              const htmlPath = path.join(clientFolder, page.name);

              // Clean HTML for better viewing
              const cleanHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${client.business_name} - ${page.name}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .info { background: #f0f0f0; padding: 10px; margin-bottom: 20px; }
    .info h2 { margin-top: 0; }
  </style>
</head>
<body>
  <div class="info">
    <h2>Client: ${client.business_name}</h2>
    <p>RFC: ${client.tax_id || 'N/A'}</p>
    <p>IDSE User: ${client.idse_user}</p>
    <p>Downloaded: ${new Date().toLocaleString()}</p>
  </div>
  <hr>
  ${html}
</body>
</html>`;

              fs.writeFileSync(htmlPath, cleanHtml);
              console.log(`     📄 Saved: ${page.name} (${html.length} bytes)`);

              // Check for login indicators
              if (html.includes('Bienvenido')) {
                console.log(`     → Contains "Bienvenido"`);
              }
              if (html.includes('Cerrar Sesión') || html.includes('Cerrar Sesion')) {
                console.log(`     → Contains "Cerrar Sesión"`);
              }
              if (html.includes(client.idse_user)) {
                console.log(`     → Contains username`);
              }

            } catch (pageError) {
              console.log(`     ⚠️ Error fetching ${page.name}: ${pageError}`);
            }
          }

          // Create an index.html for easy navigation
          const indexPath = path.join(clientFolder, 'index.html');
          fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${client.business_name} - IDSE Pages</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; }
    h1 { color: #333; }
    .info { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
    .pages { list-style: none; padding: 0; }
    .pages li { margin: 10px 0; }
    .pages a {
      display: inline-block;
      padding: 10px 20px;
      background: #007bff;
      color: white;
      text-decoration: none;
      border-radius: 4px;
    }
    .pages a:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>IDSE - ${client.business_name}</h1>
  <div class="info">
    <p><strong>RFC:</strong> ${client.tax_id || 'N/A'}</p>
    <p><strong>IDSE User:</strong> ${client.idse_user}</p>
    <p><strong>Certificate Type:</strong> ${client.cert_type}</p>
    <p><strong>Downloaded:</strong> ${new Date().toLocaleString()}</p>
  </div>
  <h2>Available Pages:</h2>
  <ul class="pages">
    <li><a href="menu.html">Menu Principal</a></li>
    <li><a href="resultados.html">Resultados</a></li>
    <li><a href="afiliacion.html">Afiliación</a></li>
  </ul>
</body>
</html>`);

          results.push({
            client: client.business_name,
            id: client.id,
            rfc: client.tax_id,
            folder: folderName,
            status: 'SUCCESS',
            filesCreated: ['index.html', 'menu.html', 'resultados.html', 'afiliacion.html', 'info.txt']
          });

        } else {
          console.log(`   ❌ LOGIN FAILED`);

          // Save error info
          const errorPath = path.join(clientFolder, 'error.txt');
          fs.writeFileSync(errorPath, `Client: ${client.business_name}
ID: ${client.id}
RFC: ${client.tax_id || 'N/A'}
Status: LOGIN FAILED
Date: ${new Date().toISOString()}`);

          results.push({
            client: client.business_name,
            id: client.id,
            rfc: client.tax_id,
            folder: folderName,
            status: 'FAILED',
            error: 'Login returned false'
          });
        }

      } catch (error) {
        console.log(`   ❌ ERROR: ${error}`);

        // Save error details
        const errorPath = path.join(clientFolder, 'error.txt');
        fs.writeFileSync(errorPath, `Client: ${client.business_name}
ID: ${client.id}
RFC: ${client.tax_id || 'N/A'}
Status: ERROR
Error: ${error}
Date: ${new Date().toISOString()}`);

        results.push({
          client: client.business_name,
          id: client.id,
          rfc: client.tax_id,
          folder: folderName,
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error)
        });
      }

      console.log("=" .repeat(80));
    }

    // Create main index.html
    createMainIndex(outputDir, results);

    // Summary
    console.log("\n\n📊 LOGIN TEST SUMMARY:\n");

    const successful = results.filter(r => r.status === 'SUCCESS');
    const failed = results.filter(r => r.status === 'FAILED');
    const errors = results.filter(r => r.status === 'ERROR');
    const skipped = results.filter(r => r.status === 'SKIPPED');

    console.log(`✅ Successful: ${successful.length}`);
    if (successful.length > 0) {
      successful.forEach(r => {
        console.log(`   - ${r.client} (RFC: ${r.rfc || 'N/A'})`);
        console.log(`     📂 Folder: ${outputDir}/${r.folder}/`);
      });
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed: ${failed.length}`);
      failed.forEach(r => {
        console.log(`   - ${r.client} (RFC: ${r.rfc || 'N/A'}): ${r.error}`);
      });
    }

    if (errors.length > 0) {
      console.log(`\n⚠️  Errors: ${errors.length}`);
      errors.forEach(r => {
        console.log(`   - ${r.client} (RFC: ${r.rfc || 'N/A'}): ${r.error}`);
      });
    }

    if (skipped.length > 0) {
      console.log(`\n⏭️  Skipped: ${skipped.length}`);
      skipped.forEach(r => {
        console.log(`   - ${r.client} (RFC: ${r.rfc || 'N/A'}): ${r.reason}`);
      });
    }

    console.log("\n📁 All files saved in: " + outputDir);
    console.log("   Open index.html in your browser to navigate all results");

  } catch (error) {
    console.error("❌ Fatal error:", error);
  } finally {
    // Clean up
    clearAllPFX();
    await endPool();
  }
}

/**
 * Create main index.html with all results
 */
function createMainIndex(outputDir: string, results: any[]) {
  const indexPath = path.join(outputDir, 'index.html');

  const successfulRows = results
    .filter(r => r.status === 'SUCCESS')
    .map(r => `
      <tr class="success">
        <td>${r.client}</td>
        <td>${r.rfc || 'N/A'}</td>
        <td><span class="badge success">✅ Success</span></td>
        <td><a href="${r.folder}/index.html">Open</a></td>
      </tr>
    `).join('');

  const failedRows = results
    .filter(r => r.status === 'FAILED')
    .map(r => `
      <tr class="failed">
        <td>${r.client}</td>
        <td>${r.rfc || 'N/A'}</td>
        <td><span class="badge failed">❌ Failed</span></td>
        <td><a href="${r.folder}/error.txt">View Error</a></td>
      </tr>
    `).join('');

  const errorRows = results
    .filter(r => r.status === 'ERROR')
    .map(r => `
      <tr class="error">
        <td>${r.client}</td>
        <td>${r.rfc || 'N/A'}</td>
        <td><span class="badge error">⚠️ Error</span></td>
        <td><a href="${r.folder}/error.txt">View Error</a></td>
      </tr>
    `).join('');

  const skippedRows = results
    .filter(r => r.status === 'SKIPPED')
    .map(r => `
      <tr class="skipped">
        <td>${r.client}</td>
        <td>${r.rfc || 'N/A'}</td>
        <td><span class="badge skipped">⏭️ Skipped</span></td>
        <td><a href="${r.folder}/info.txt">View Info</a></td>
      </tr>
    `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>IDSE Login Test Results</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      margin-top: 0;
    }
    .summary {
      display: flex;
      gap: 20px;
      margin: 30px 0;
    }
    .stat {
      flex: 1;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat.success { background: #d4edda; color: #155724; }
    .stat.failed { background: #f8d7da; color: #721c24; }
    .stat.error { background: #fff3cd; color: #856404; }
    .stat.skipped { background: #d1ecf1; color: #0c5460; }
    .stat h2 { margin: 0; font-size: 2em; }
    .stat p { margin: 5px 0 0; font-size: 0.9em; text-transform: uppercase; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    th {
      background: #f8f9fa;
      padding: 12px;
      text-align: left;
      border-bottom: 2px solid #dee2e6;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #dee2e6;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .badge.success { background: #d4edda; color: #155724; }
    .badge.failed { background: #f8d7da; color: #721c24; }
    .badge.error { background: #fff3cd; color: #856404; }
    .badge.skipped { background: #d1ecf1; color: #0c5460; }
    a {
      color: #007bff;
      text-decoration: none;
      padding: 4px 12px;
      border: 1px solid #007bff;
      border-radius: 4px;
      display: inline-block;
    }
    a:hover {
      background: #007bff;
      color: white;
    }
    .timestamp {
      color: #6c757d;
      font-size: 0.9em;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 IDSE Login Test Results</h1>

    <div class="summary">
      <div class="stat success">
        <h2>${results.filter(r => r.status === 'SUCCESS').length}</h2>
        <p>Successful</p>
      </div>
      <div class="stat failed">
        <h2>${results.filter(r => r.status === 'FAILED').length}</h2>
        <p>Failed</p>
      </div>
      <div class="stat error">
        <h2>${results.filter(r => r.status === 'ERROR').length}</h2>
        <p>Errors</p>
      </div>
      <div class="stat skipped">
        <h2>${results.filter(r => r.status === 'SKIPPED').length}</h2>
        <p>Skipped</p>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th>RFC</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${successfulRows}
        ${failedRows}
        ${errorRows}
        ${skippedRows}
      </tbody>
    </table>

    <p class="timestamp">Generated: ${new Date().toLocaleString()}</p>
  </div>
</body>
</html>`;

  fs.writeFileSync(indexPath, html);
  console.log(`\n📄 Main index created: ${indexPath}`);
}

// Run
if (import.meta.main) {
  const arg = process.argv[2];

  if (arg === '--all') {
    console.log('\nStarting PFX server for CER+KEY clients...');
    console.log('Server will be available at http://localhost:8080\n');

    // Import the server to start it
    await import('./pfx-server');

    // Give server time to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    testAllLogins();
  } else {
    console.log(`
📝 IDSE Login Tester

Usage:
  bun test-all-logins.ts --all    # Test all clients and save HTML

The script will:
  1. Start a local PFX server for CER+KEY clients
  2. Create a folder for each client (using their RFC)
  3. Login to IDSE (supports both PFX and CER+KEY)
  4. Download multiple pages as HTML
  5. Create an index.html for easy navigation

Output: idse-output/
    `);
  }
}