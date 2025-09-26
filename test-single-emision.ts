import { IDSEConnection } from "./IDSEConnection";
import { getClientIDSE } from "./idse-from-db";
import { endPool } from "./db";
import * as cheerio from 'cheerio';

async function testSingleEmision() {
  console.log("\n=== Testing Single Client Emisión ===\n");

  try {
    // Get GROUP INCORPORATE KAMBAUL (we know it works)
    const clientId = 1705; // GROUP INCORPORATE KAMBAUL SA DE CV (PRUEBA) - from the successful list
    const client = await getClientIDSE(clientId);

    if (!client) {
      console.log("Client not found");
      return;
    }

    console.log(`Client: ${client.business_name}`);
    console.log(`RFC: ${client.tax_id}`);
    console.log(`IDSE User: ${client.idse_user}`);

    // Login
    const idse = new IDSEConnection(
      client.idse_user,
      client.idse_password,
      client.pfx_url
    );

    const loginResult = await idse.login();
    console.log(`Login result: ${loginResult}`);

    if (!loginResult) {
      console.log("Login failed");
      return;
    }

    // Get cookies
    const cookies = (idse as any).cookies;
    console.log(`\nCookies obtained: ${cookies ? 'Yes' : 'No'}`);

    // Navigate to Emisión
    console.log("\n📊 Navigating to Emisión module...");

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

    console.log(`Emisión response status: ${emisionResponse.status}`);
    const emisionHtml = await emisionResponse.text();

    // Save the HTML for inspection
    const fs = await import('fs');
    fs.writeFileSync('emision-page.html', emisionHtml);
    console.log("Saved emisión page to emision-page.html");

    // Check for patron field in the form
    const $ = cheerio.load(emisionHtml);

    // Look for patron input field or selector
    const patronInputs = $('input[name*="patron"], select[name*="patron"]');
    console.log(`\nFound ${patronInputs.length} patron input fields`);

    patronInputs.each((i, elem) => {
      const name = $(elem).attr('name');
      const value = $(elem).val();
      const id = $(elem).attr('id');
      console.log(`  Field ${i + 1}: name="${name}", value="${value}", id="${id}"`);
    });

    // Look for patron values in options or text
    const patronOptions = $('option').filter((i, el) => {
      const text = $(el).text();
      return text.match(/[A-Z]\d{10}/); // Pattern like R1377865107
    });

    console.log(`\nFound ${patronOptions.length} patron options`);
    patronOptions.each((i, elem) => {
      const value = $(elem).val();
      const text = $(elem).text();
      console.log(`  Option ${i + 1}: value="${value}", text="${text}"`);
    });

    // Try a direct query with a test patron
    const testPatron = "R137731410"; // Example patron from your curl
    console.log(`\n🔍 Testing direct query with patron: ${testPatron}`);

    const consultaUrl = `https://idse.imss.gob.mx/imss/ConsultaEmision.idse?patronConsulta=${testPatron}&consultarEmisiones=Consultar`;

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

    console.log(`Consulta response status: ${consultaResponse.status}`);
    const consultaHtml = await consultaResponse.text();

    fs.writeFileSync('consulta-emision.html', consultaHtml);
    console.log("Saved consulta page to consulta-emision.html");

    // Parse the table
    const $2 = cheerio.load(consultaHtml);

    // Look for tables
    const tables = $2('table');
    console.log(`\nFound ${tables.length} tables in response`);

    tables.each((i, table) => {
      const headers = $2(table).find('th').map((_, th) => $2(th).text().trim()).get();
      console.log(`\nTable ${i + 1} headers:`, headers);

      // If this looks like the emissions table
      if (headers.some(h => h.includes('Emisi') || h.includes('Saldo'))) {
        console.log("This appears to be the emissions table!");

        $2(table).find('tbody tr').each((j, row) => {
          const cells = $2(row).find('td').map((_, td) => $2(td).text().trim()).get();
          if (cells.length > 0) {
            console.log(`  Row ${j + 1}:`, cells);
          }
        });
      }
    });

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await endPool();
  }
}

// Run
if (import.meta.main) {
  testSingleEmision();
}