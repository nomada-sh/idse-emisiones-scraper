import * as cheerio from "cheerio";
import forge from "node-forge";

export class IDSEConnection {
  private cookies?: string;
  private isInitialized: boolean = false;
  private password: string;
  private pfxURL: string;
  private user: string;
  private verbose: boolean = false;

  constructor(user: string, password: string, pfxURL: string, verbose: boolean = false) {
    this.password = password;
    this.pfxURL = pfxURL;
    this.user = user;
    this.verbose = verbose;
  }

  public isLoggedIn(): boolean {
    return !!this.cookies && this.isInitialized;
  }

  private async generarPKCS7(contenido: string): Promise<string> {
    if (this.verbose) {
      console.log(
        "IDSE: Starting PKCS7 generation, content length:",
        contenido.length,
      );
    }

    if (!contenido || contenido.trim().length === 0) {
      throw new Error("Cannot generate PKCS7 from empty content");
    }

    if (this.verbose) console.log("IDSE: Fetching PFX file from:", this.pfxURL);

    const pfxResponse = await fetch(this.pfxURL, {
      signal: AbortSignal.timeout(20000),
    });

    if (!pfxResponse.ok) {
      throw new Error(
        `Failed to fetch PFX file: ${pfxResponse.status} ${pfxResponse.statusText}`,
      );
    }

    if (this.verbose) console.log("IDSE: PFX file fetched successfully");
    const pfxArrayBuffer = await pfxResponse.arrayBuffer();
    if (this.verbose) console.log("IDSE: PFX file size:", pfxArrayBuffer.byteLength, "bytes");

    if (pfxArrayBuffer.byteLength === 0) {
      throw new Error("PFX file is empty");
    }

    try {
      const pfxByteBuffer = forge.util.createBuffer(pfxArrayBuffer);
      if (this.verbose) console.log("IDSE: Converting PFX to ASN.1...");
      const p12Asn1 = forge.asn1.fromDer(pfxByteBuffer);
      if (this.verbose) console.log("IDSE: Parsing PKCS12 with password...");
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, this.password);

      let privateKey: forge.pki.PrivateKey | null = null;
      let certificate: forge.pki.Certificate | null = null;

      if (this.verbose) console.log("IDSE: Extracting private key and certificate...");
      for (const safeContent of p12.safeContents) {
        for (const bag of safeContent.safeBags) {
          if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && bag.key) {
            privateKey = bag.key;
            if (this.verbose) console.log("IDSE: Private key found");
          } else if (bag.type === forge.pki.oids.certBag && bag.cert) {
            certificate = bag.cert;
            if (this.verbose) console.log("IDSE: Certificate found");
          }
        }
      }

      if (!privateKey || !certificate) {
        throw new Error("No se pudo cargar la llave privada o el certificado.");
      }

      if (this.verbose) console.log("IDSE: Creating PKCS7 signed data...");
      const p7 = forge.pkcs7.createSignedData();
      p7.content = forge.util.createBuffer(contenido, "utf8");
      p7.addCertificate(certificate);
      const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

      p7.addSigner({
        key: privateKeyPem,
        certificate,
        digestAlgorithm: forge.pki.oids.sha256!,
      });

      if (this.verbose) console.log("IDSE: Signing PKCS7 data...");
      p7.sign();
      const pem = forge.pkcs7.messageToPem(p7);
      if (this.verbose) console.log("IDSE: PKCS7 generation completed, PEM length:", pem.length);

      if (!pem || pem.length === 0) {
        throw new Error("PKCS7 generation produced empty result");
      }

      return pem;
    } catch (error) {
      if (this.verbose) {
        console.error("IDSE: Error during PKCS7 generation:", error);
      }
      if (error instanceof Error) {
        if (
          error.message.includes("Invalid password") ||
          error.message.includes("MAC verify failure")
        ) {
          throw new Error("Contraseña del certificado PFX incorrecta");
        }
        if (
          error.message.includes("Invalid PFX") ||
          error.message.includes("ASN.1")
        ) {
          throw new Error("Archivo PFX inválido o corrupto");
        }
      }
      throw error;
    }
  }

  private get defaultHeaders() {
    return {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      "Sec-Fetch-Site": "same-origin",
      "Accept-Language": "es-MX,es-419;q=0.9,es;q=0.8",
      "Sec-Fetch-Mode": "cors",
      Origin: "https://idse.imss.gob.mx",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      Referer: "https://idse.imss.gob.mx/imss/",
      "Sec-Fetch-Dest": "empty",
      "X-Requested-With": "XMLHttpRequest",
      Priority: "u=3, i",
    };
  }

  public async login(): Promise<boolean> {
    if (this.verbose) console.log("IDSE: Starting login process");

    const firstURL = "https://idse.imss.gob.mx/imss/SecuenciaFirma.idse";
    const firmaBody = new URLSearchParams({
      siteId: "9",
      location: "https://idse.imss.gob.mx/imss/",
    });

    if (this.verbose) console.log("IDSE: Sending initial request to SecuenciaFirma.idse");

    const firstResponse = await fetch(firstURL, {
      method: "POST",
      headers: this.defaultHeaders,
      body: firmaBody.toString(),
      signal: AbortSignal.timeout(30000),
    });

    console.log(
      "IDSE: SecuenciaFirma.idse response received, status:",
      firstResponse.status,
    );

    if (!firstResponse.ok) {
      throw new Error(
        `SecuenciaFirma failed: ${firstResponse.status} ${firstResponse.statusText}`,
      );
    }

    const firstResponseText = await firstResponse.text();
    if (this.verbose) console.log("IDSE: Response text length:", firstResponseText.length);

    if (!firstResponseText || firstResponseText.trim().length === 0) {
      throw new Error("SecuenciaFirma returned empty response");
    }

    if (this.verbose) console.log("IDSE: Generating PKCS7 signature...");
    const pkcs7 = await this.generarPKCS7(firstResponseText);
    if (this.verbose) console.log("IDSE: PKCS7 signature generated, length:", pkcs7.length);

    if (!pkcs7 || pkcs7.length === 0) {
      throw new Error("PKCS7 generation failed - empty result");
    }

    const parsedpkcs7 = pkcs7
      .replace(/\r\n/g, "")
      .replace("-----BEGIN PKCS7-----", "")
      .replace("-----END PKCS7-----", "-----END+PKCS7-----");

    const loginBody = new URLSearchParams({
      siteId: "9",
      pkcs7: parsedpkcs7,
      certificado: "CERT.pfx",
      llave: "CERT.pfx",
      idUsuario: this.user,
      password: this.password,
    });

    if (this.verbose) console.log("IDSE: Sending login request to AccesoIDSE.idse");

    const response = await fetch(
      "https://idse.imss.gob.mx/imss/AccesoIDSE.idse",
      {
        method: "POST",
        headers: {
          Host: "idse.imss.gob.mx",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://idse.imss.gob.mx",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
          Referer: "https://idse.imss.gob.mx/imss/",
          "Sec-Fetch-Dest": "document",
          "Accept-Language": "en-US,en;q=0.9",
          Priority: "u=0, i",
          Connection: "close",
          "Content-Length": loginBody.toString().length.toString(),
        },
        body: loginBody,
        signal: AbortSignal.timeout(30000),
      },
    );

    if (this.verbose) {
      console.log("IDSE: Login response received, status:", response.status);
      console.log(
        "IDSE: Login response headers:",
        Object.fromEntries(response.headers.entries()),
      );
    }

    if (!response.ok) {
      throw new Error(
        `AccesoIDSE failed: ${response.status} ${response.statusText}`,
      );
    }

    const setCookieHeader = response.headers.get("set-cookie");
    if (this.verbose) console.log("IDSE: Set-Cookie header received:", setCookieHeader);

    this.cookies = setCookieHeader || undefined;
    if (this.verbose) console.log("IDSE: Cookies after assignment:", this.cookies);

    if (!this.cookies) {
      const responseText = await response.text();
      if (this.verbose) {
        console.log("IDSE: No cookies received - login may have failed");
        console.log(
          "IDSE: Login response body (first 500 chars):",
          responseText.substring(0, 500),
        );
      }
      throw new Error(
        "No cookies received from IDSE login - authentication may have failed",
      );
    }

    this.isInitialized = true;
    if (this.verbose) console.log("IDSE: Login process completed successfully");
    return true;
  }

  public async getMovements(paginacion: number = 50): Promise<any[]> {
    if (this.verbose) console.log("IDSE: Starting getMovements() with pagination:", paginacion);

    if (!this.isLoggedIn()) {
      if (this.verbose) console.log("IDSE: Not logged in, attempting login...");
      await this.login();
    }

    if (this.verbose) console.log("IDSE: Fetching movements list from IDSE...");

    const params = new URLSearchParams();
    params.append("loteID", "");
    params.append("loteFecha", "");
    params.append("act", "encuesta");
    params.append("paginacion", paginacion.toString());

    const response = await fetch(
      "https://idse.imss.gob.mx/imss/AfiliaResultados.idse",
      {
        method: "POST",
        headers: {
          Host: "idse.imss.gob.mx",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://idse.imss.gob.mx",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
          Referer: "https://idse.imss.gob.mx/imss/AfiliaResultados.idse",
          "Sec-Fetch-Dest": "document",
          "Accept-Language": "en-US,en;q=0.9",
          Priority: "u=0, i",
          Connection: "keep-alive",
          Cookie: this.cookies!,
        },
        body: params,
      },
    );

    if (this.verbose) {
      console.log(
        "IDSE: Movements list response received, status:",
        response.status,
      );
    }

    const movementsListHtml = await response.text();
    if (this.verbose) console.log("IDSE: Movements list HTML length:", movementsListHtml.length);

    const $ = cheerio.load(movementsListHtml);
    const allTables = $("table.table-striped");
    const movements: any[] = [];

    if (this.verbose) {
      console.log(
        `IDSE: Found ${allTables.length} tables with class "table-striped"`,
      );
    }

    allTables.each((tableIndex, tableElement) => {
      const tableClasses = $(tableElement).attr("class") || "";
      let tableStatus = "Unknown";

      if (tableClasses.includes("bottom-buffer")) {
        tableStatus = "Procesado";
      } else if (tableClasses.includes("table-striped")) {
        tableStatus = "Enviado";
      }

      const rows = $(tableElement).find("tr[class]");
      rows.each((_, rowElement) => {
        const cells = $(rowElement).find("td");
        if (cells.length >= 4 && !cells.eq(0).attr("colspan")) {
          const firstCell = cells.eq(0);
          const loteLink = firstCell.find("a").first();
          const lote = loteLink.text().trim();
          const tipoLote = cells.eq(1).text().trim();
          const fechaTransaccion = cells.eq(2).text().trim();

          movements.push({
            lote,
            tipoLote,
            fechaTransaccion,
            status: tableStatus,
          });
        }
      });
    });

    console.log(
      "IDSE: getMovements() completed, found",
      movements.length,
      "movements",
    );
    return movements;
  }
}
