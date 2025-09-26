import { getClientIDSE } from "./idse-from-db";
import { IDSEConnection } from "./IDSEConnection";
import { endPool } from "./db";
import * as fs from "fs";
import * as cheerio from "cheerio";

async function checkEmisionFlow(clientId: number) {
  try {
    const client = await getClientIDSE(clientId);

    if (!client) {
      console.log("Client not found");
      return;
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`Client: ${client.business_name}`);
    console.log(`RFC: ${client.tax_id}`);
    console.log(`IDSE User: ${client.idse_user}`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    // Login
    const idse = new IDSEConnection(
      client.idse_user,
      client.idse_password,
      client.pfx_url,
      false // No verbose
    );

    const loginResult = await idse.login();
    console.log(`Step 1: Login → ${loginResult ? '✅' : '❌'}`);

    if (!loginResult) return;

    const cookies = (idse as any).cookies;

    // Navigate to Emisión
    console.log(`Step 2: Navigate to Emisión module...`);

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

    console.log(`        Status: ${emisionResponse.status}`);

    const emisionHtml = await emisionResponse.text();
    fs.writeFileSync('step2_emision.html', emisionHtml);

    // Parse the HTML to check what we get
    const $ = cheerio.load(emisionHtml);

    // Check if we're on the Emisión page
    const pageTitle = $('title').text();
    console.log(`        Page title: "${pageTitle}"`);

    // Look for form elements
    const forms = $('form');
    console.log(`        Forms found: ${forms.length}`);

    forms.each((i, form) => {
      const name = $(form).attr('name');
      const action = $(form).attr('action');
      console.log(`          Form ${i+1}: name="${name}", action="${action}"`);
    });

    // Look for input fields
    const inputs = $('input[type="text"], input[type="hidden"], select');
    console.log(`        Input fields: ${inputs.length}`);

    // Check specifically for patron field
    const patronInput = $('input[name="patronConsulta"], select[name="patronConsulta"]');
    if (patronInput.length > 0) {
      console.log(`        ✅ Found patron input field`);
      const inputType = patronInput.prop('tagName');
      console.log(`           Type: ${inputType}`);

      if (inputType === 'SELECT') {
        const options = patronInput.find('option');
        console.log(`           Options: ${options.length}`);
        options.each((i, opt) => {
          const val = $(opt).val();
          const text = $(opt).text();
          if (val) {
            console.log(`             - ${val}: ${text}`);
          }
        });
      }
    } else {
      console.log(`        ❌ No patron input field found`);
    }

    // Check if the page directly shows emission data
    const hasData = emisionHtml.includes('fillNumerosRegistros') ||
                   emisionHtml.includes('fillSaldosEMA');

    if (hasData) {
      console.log(`\nStep 3: ✅ Emission data found directly on page!`);

      // Extract the data
      const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let match;

      while ((match = scriptRegex.exec(emisionHtml)) !== null) {
        const scriptContent = match[1];

        if (scriptContent.includes('fillNumerosRegistros')) {
          const registroRegex = /fillNumerosRegistros\("([^"]*)",\s*"([^"]*)"\)/g;
          const registros = [...scriptContent.matchAll(registroRegex)];

          console.log(`        Registros patronales found: ${registros.length}`);
          registros.forEach((r, i) => {
            console.log(`          ${i+1}. ${r[1]}`);
          });
        }
      }
    } else {
      console.log(`\nStep 3: ❌ No emission data on initial page`);
      console.log(`        Need to query with specific patron or navigate further`);

      // Try to find what we need to do next
      const links = $('a[href*="Emision"], a[href*="emision"]');
      console.log(`        Emission-related links: ${links.length}`);

      links.each((i, link) => {
        const href = $(link).attr('href');
        const text = $(link).text().trim();
        console.log(`          Link ${i+1}: "${text}" -> ${href}`);
      });
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await endPool();
  }
}

// Run
if (import.meta.main) {
  const clientId = parseInt(process.argv[2] || '1554');
  checkEmisionFlow(clientId);
}