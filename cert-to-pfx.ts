import forge from 'node-forge';
import fs from 'fs';
import path from 'path';

/**
 * Convert CER+KEY files to PFX format
 * This is useful for IDSE authentication which can use either format
 */
export class CertificateConverter {
  /**
   * Convert CER+KEY to PFX using node-forge
   * @param cerPath - Path to .cer certificate file
   * @param keyPath - Path to .key private key file
   * @param password - Password to protect the PFX file
   * @param outputPath - Optional output path for PFX file
   */
  static async convertCerKeyToPfx(
    cerPath: string,
    keyPath: string,
    password: string,
    outputPath?: string
  ): Promise<Buffer> {
    try {
      console.log('📜 Reading certificate file:', cerPath);
      const cerContent = fs.readFileSync(cerPath, 'utf8');

      console.log('🔑 Reading key file:', keyPath);
      const keyContent = fs.readFileSync(keyPath, 'utf8');

      // Parse certificate
      let certificate: forge.pki.Certificate;
      if (cerContent.includes('-----BEGIN CERTIFICATE-----')) {
        // PEM format
        certificate = forge.pki.certificateFromPem(cerContent);
      } else {
        // DER format (binary)
        const cerBuffer = fs.readFileSync(cerPath);
        const asn1 = forge.asn1.fromDer(cerBuffer.toString('binary'));
        certificate = forge.pki.certificateFromAsn1(asn1);
      }

      // Parse private key
      let privateKey: forge.pki.PrivateKey;
      if (keyContent.includes('-----BEGIN')) {
        // PEM format
        privateKey = forge.pki.privateKeyFromPem(keyContent);
      } else {
        // DER format (binary)
        const keyBuffer = fs.readFileSync(keyPath);
        const asn1 = forge.asn1.fromDer(keyBuffer.toString('binary'));
        privateKey = forge.pki.privateKeyFromAsn1(asn1);
      }

      console.log('🔐 Creating PKCS12/PFX...');

      // Create PKCS12
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
        privateKey,
        certificate,
        password,
        {
          algorithm: '3des' // 3DES encryption for compatibility
        }
      );

      // Convert to DER
      const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
      const pfxBuffer = Buffer.from(p12Der, 'binary');

      // Save to file if output path provided
      if (outputPath) {
        fs.writeFileSync(outputPath, pfxBuffer);
        console.log('✅ PFX file saved to:', outputPath);
      }

      return pfxBuffer;
    } catch (error) {
      console.error('❌ Error converting certificate:', error);
      throw error;
    }
  }

  /**
   * Convert CER+KEY from URLs (for files stored in S3/cloud)
   */
  static async convertFromUrls(
    cerUrl: string,
    keyUrl: string,
    password: string
  ): Promise<Buffer> {
    console.log('🌐 Fetching certificate from URL...');
    const cerResponse = await fetch(cerUrl);
    if (!cerResponse.ok) {
      throw new Error(`Failed to fetch CER file: ${cerResponse.status}`);
    }

    console.log('🌐 Fetching key from URL...');
    const keyResponse = await fetch(keyUrl);
    if (!keyResponse.ok) {
      throw new Error(`Failed to fetch KEY file: ${keyResponse.status}`);
    }

    const cerBuffer = Buffer.from(await cerResponse.arrayBuffer());
    const keyBuffer = Buffer.from(await keyResponse.arrayBuffer());

    // Try to parse as text first (PEM format)
    let cerContent = cerBuffer.toString('utf8');
    let keyContent = keyBuffer.toString('utf8');

    // Parse certificate
    let certificate: forge.pki.Certificate;

    // Check if the "CER" file is actually a PFX (misnamed)
    if (cerBuffer.length > 100 && cerBuffer[0] === 0x30 && cerBuffer[1] === 0x82) {
      // Check if it's a PKCS#12/PFX structure
      try {
        const testAsn1 = forge.asn1.fromDer(cerBuffer.toString('binary'));
        const testP12 = forge.pkcs12.pkcs12FromAsn1(testAsn1, password);

        // If it's a PFX, just return it as-is
        console.log('🔄 CER file is actually a PFX, returning as-is');
        return cerBuffer;
      } catch (e) {
        // Not a PFX, continue with normal CER parsing
      }
    }

    if (cerContent.includes('-----BEGIN CERTIFICATE-----')) {
      certificate = forge.pki.certificateFromPem(cerContent);
    } else {
      // DER format (binary)
      const asn1 = forge.asn1.fromDer(cerBuffer.toString('binary'));
      certificate = forge.pki.certificateFromAsn1(asn1);
    }

    // Parse private key (may be encrypted)
    let privateKey: forge.pki.PrivateKey;
    if (keyContent.includes('-----BEGIN')) {
      // PEM format - check if encrypted
      if (keyContent.includes('ENCRYPTED')) {
        privateKey = forge.pki.decryptRsaPrivateKey(keyContent, password);
        if (!privateKey) {
          throw new Error('Failed to decrypt private key with provided password');
        }
      } else {
        privateKey = forge.pki.privateKeyFromPem(keyContent);
      }
    } else {
      // DER format (binary) - may be encrypted PKCS#8
      try {
        // First try as unencrypted
        const asn1 = forge.asn1.fromDer(keyBuffer.toString('binary'));
        privateKey = forge.pki.privateKeyFromAsn1(asn1);
      } catch (e) {
        // If that fails, try as encrypted PKCS#8
        try {
          const keyInfo = forge.pki.decryptPrivateKeyInfo(
            forge.asn1.fromDer(keyBuffer.toString('binary')),
            password
          );
          if (!keyInfo) {
            throw new Error('Failed to decrypt private key');
          }
          privateKey = forge.pki.privateKeyFromAsn1(keyInfo);
        } catch (e2) {
          // Last attempt: try as encrypted PKCS#5
          const encryptedKey = forge.pki.encryptedPrivateKeyFromPem(
            forge.pki.encryptedPrivateKeyToPem(
              forge.asn1.fromDer(keyBuffer.toString('binary'))
            )
          );
          privateKey = forge.pki.decryptRsaPrivateKey(
            forge.pki.encryptedPrivateKeyToPem(encryptedKey),
            password
          );
          if (!privateKey) {
            throw new Error('Cannot decrypt private key with any method');
          }
        }
      }
    }

    console.log('🔐 Creating PKCS12/PFX from URLs...');

    // Create PKCS12
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
      privateKey,
      certificate,
      password,
      {
        algorithm: '3des'
      }
    );

    const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
    return Buffer.from(p12Der, 'binary');
  }

  /**
   * Validate that a PFX file is valid
   */
  static validatePfx(pfxBuffer: Buffer, password: string): boolean {
    try {
      const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

      // Check if we can extract certificate and key
      let hasKey = false;
      let hasCert = false;

      for (const safeContent of p12.safeContents) {
        for (const bag of safeContent.safeBags) {
          if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && bag.key) {
            hasKey = true;
          } else if (bag.type === forge.pki.oids.certBag && bag.cert) {
            hasCert = true;
          }
        }
      }

      return hasKey && hasCert;
    } catch (error) {
      console.error('❌ PFX validation failed:', error);
      return false;
    }
  }
}

// Command line usage
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.log(`
📦 CER+KEY to PFX Converter

Usage:
  bun cert-to-pfx.ts <cer_file> <key_file> <password> [output_file]

Example:
  bun cert-to-pfx.ts cert.cer private.key myPassword output.pfx

Or for URLs:
  bun cert-to-pfx.ts --urls <cer_url> <key_url> <password> [output_file]
    `);
    process.exit(1);
  }

  try {
    let pfxBuffer: Buffer;
    let outputPath: string | undefined;

    if (args[0] === '--urls') {
      // Convert from URLs
      const [, cerUrl, keyUrl, password, output] = args;
      outputPath = output;

      console.log('\n🔄 Converting from URLs to PFX...\n');
      pfxBuffer = await CertificateConverter.convertFromUrls(cerUrl, keyUrl, password);

    } else {
      // Convert from local files
      const [cerPath, keyPath, password, output] = args;
      outputPath = output;

      console.log('\n🔄 Converting local files to PFX...\n');
      pfxBuffer = await CertificateConverter.convertCerKeyToPfx(
        cerPath,
        keyPath,
        password,
        outputPath
      );
    }

    // Validate the generated PFX
    const password = args[args.length - 2] || args[3];
    if (CertificateConverter.validatePfx(pfxBuffer, password)) {
      console.log('✅ PFX file created successfully!');
      console.log(`   Size: ${pfxBuffer.length} bytes`);

      if (!outputPath) {
        outputPath = 'output.pfx';
        fs.writeFileSync(outputPath, pfxBuffer);
        console.log(`   Saved to: ${outputPath}`);
      }
    } else {
      console.error('❌ PFX validation failed');
    }

  } catch (error) {
    console.error('❌ Conversion failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export default CertificateConverter;