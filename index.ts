import { IDSEConnection } from './IDSEConnection';
import { createIDSEConnectionFromDB, listClientsWithIDSE } from './idse-from-db';
import { endPool } from './db';

// Example usage
async function main() {
  console.log('\n=== IDSE Connection POC ===\n');

  // Check if database is configured
  const dbUri = process.env.PAYJOB_DB_URI || process.env.DATABASE_URL;

  if (dbUri) {
    console.log('📊 Database connection configured. Fetching from database...\n');

    try {
      // List all clients with IDSE
      console.log('📋 Listing clients with IDSE credentials:\n');
      const clients = await listClientsWithIDSE();

      if (clients.length === 0) {
        console.log('No clients with IDSE credentials found in database');
      } else {
        clients.forEach((client, index) => {
          console.log(`${index + 1}. [ID: ${client.id}] ${client.business_name}`);
          console.log(`   IDSE User: ${client.idse_user}`);
          console.log(`   Has Password: ${client.has_password}`);
          console.log(`   Has PFX: ${client.has_pfx}`);
          console.log('');
        });

        // Try to connect with the first valid client
        const validClient = clients.find(c => c.has_password === '✓' && c.has_pfx === '✓');

        if (validClient) {
          console.log(`\n🔌 Using client: ${validClient.business_name}\n`);
          const idse = await createIDSEConnectionFromDB(validClient.id);

          if (idse) {
            await testConnection(idse);
          }
        } else {
          console.log('⚠️  No clients with complete IDSE credentials found');
        }
      }
    } catch (error) {
      console.error('❌ Database error:', error);
      console.log('\nFalling back to environment variables...');
      await useEnvCredentials();
    } finally {
      await endPool();
    }
  } else {
    console.log('📝 No database configured. Using environment variables...\n');
    await useEnvCredentials();
  }
}

async function useEnvCredentials() {
  const user = process.env.IDSE_USER || '';
  const password = process.env.IDSE_PASSWORD || '';
  const pfxURL = process.env.IDSE_PFX_URL || '';

  if (!user || !password || !pfxURL) {
    console.error('Please set IDSE_USER, IDSE_PASSWORD, and IDSE_PFX_URL environment variables');
    process.exit(1);
  }

  try {
    const idse = new IDSEConnection(user, password, pfxURL);
    await testConnection(idse);
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

async function testConnection(idse: IDSEConnection) {
  console.log('Attempting to login to IDSE...');
  await idse.login();
  console.log('✅ Login successful!\n');

  console.log('Fetching movements...');
  const movements = await idse.getMovements(10);
  console.log(`✅ Found ${movements.length} movements\n`);

  if (movements.length > 0) {
    console.log('First 3 movements:');
    movements.slice(0, 3).forEach((movement, index) => {
      console.log(`  ${index + 1}. Lote: ${movement.lote}, Status: ${movement.status}, Date: ${movement.fechaTransaccion}`);
    });
  }
}

// Run the example
if (import.meta.main) {
  main();
}