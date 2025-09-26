import { getClientIDSE } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import { endPool } from "./db";
import * as fs from "fs";

async function debugClient(clientId: number) {
  try {
    const client = await getClientIDSE(clientId);

    if (!client) {
      console.log("Client not found");
      return;
    }

    console.log(`\nDebugging: ${client.business_name}`);
    console.log(`RFC: ${client.tax_id}`);
    console.log(`IDSE User: ${client.idse_user}`);

    // Login with verbose OFF
    const idse = new IDSEConnection(
      client.idse_user,
      client.idse_password,
      client.pfx_url,
      false // No verbose
    );

    const loginResult = await idse.login();
    console.log(`Login: ${loginResult ? '✅' : '❌'}`);

    if (!loginResult) {
      console.log("Login failed");
      return;
    }

    const cookies = (idse as any).cookies;

    // Navigate to Emisión
    console.log("\nNavigating to Emisión module...");

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

    const html = await emisionResponse.text();

    // Save HTML for inspection
    const filename = `debug_${client.id}_emision.html`;
    fs.writeFileSync(filename, html);
    console.log(`\nHTML saved to: ${filename}`);

    // Look for the JavaScript functions
    console.log("\nSearching for JavaScript data...");

    const hasRegistros = html.includes('fillNumerosRegistros');
    const hasSaldos = html.includes('fillSaldosEMA');
    const hasNombres = html.includes('fillNombres');

    console.log(`fillNumerosRegistros: ${hasRegistros ? '✅' : '❌'}`);
    console.log(`fillSaldosEMA: ${hasSaldos ? '✅' : '❌'}`);
    console.log(`fillNombres: ${hasNombres ? '✅' : '❌'}`);

    // Look for select/input fields for patron
    const patronRegex = /<select[^>]*name="patronConsulta"[^>]*>([\s\S]*?)<\/select>/gi;
    const patronMatch = patronRegex.exec(html);

    if (patronMatch) {
      console.log("\n✅ Found patron selector:");
      // Extract options
      const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
      let optionMatch;
      let count = 0;
      while ((optionMatch = optionRegex.exec(patronMatch[1])) !== null) {
        count++;
        console.log(`  Option ${count}: value="${optionMatch[1]}", text="${optionMatch[2].trim()}"`);
      }
    } else {
      console.log("\n❌ No patron selector found");
    }

    // Check if there's a message about no data
    if (html.includes('No se encontraron') || html.includes('no hay datos') || html.includes('sin información')) {
      console.log("\n⚠️ Page may indicate no data available");
    }

    // Extract any visible text about patrones
    const patronTextRegex = /[A-Z]\d{10}/g;
    const patronMatches = html.match(patronTextRegex);
    if (patronMatches && patronMatches.length > 0) {
      console.log(`\n📋 Found patron codes in HTML: ${[...new Set(patronMatches)].join(', ')}`);
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await endPool();
  }
}

// Run with client ID from command line
if (import.meta.main) {
  const clientId = parseInt(process.argv[2] || '1554');
  debugClient(clientId);
}