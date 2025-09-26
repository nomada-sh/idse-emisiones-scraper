import { query, endPool } from "./db";

async function checkPatronInfo() {
  try {
    // Check columns in clients table
    const columns = await query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'clients'
      ORDER BY ordinal_position
    `);

    console.log("Columns in clients table:");
    columns.forEach(col => {
      if (col.column_name.includes('patron') ||
          col.column_name.includes('registro') ||
          col.column_name.includes('employer')) {
        console.log(`  - ${col.column_name} *`);
      } else {
        console.log(`  - ${col.column_name}`);
      }
    });

    // Check for patron-related tables
    const tables = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND (
        table_name LIKE '%patron%'
        OR table_name LIKE '%employer%'
        OR table_name LIKE '%registro%'
      )
      ORDER BY table_name
    `);

    console.log("\nPatron-related tables:");
    tables.forEach(t => console.log(`  - ${t.table_name}`));

    // Check if there's a simple patron field in clients
    const sampleClient = await query(`
      SELECT id, business_name, registro_patronal_imss, no_registro_patronal
      FROM clients
      WHERE id IN (1554, 1534, 887)
      LIMIT 5
    `);

    console.log("\nSample client data:");
    sampleClient.forEach(c => {
      console.log(`  Client ${c.id}: ${c.business_name}`);
      console.log(`    registro_patronal_imss: ${c.registro_patronal_imss}`);
      console.log(`    no_registro_patronal: ${c.no_registro_patronal}`);
    });

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await endPool();
  }
}

checkPatronInfo();