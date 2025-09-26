import { query } from './db';

async function checkTables() {
  console.log('\n=== Checking Database Tables ===\n');
  
  try {
    // Query to list all tables
    const tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_name LIKE '%client%'
      ORDER BY table_name
    `);
    
    console.log('Tables containing "client":\n');
    tables.forEach((t: any) => console.log(`  - ${t.table_name}`));
    
    // Check for IDSE-related tables
    const idse_tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND (table_name LIKE '%idse%' OR table_name LIKE '%pfx%')
      ORDER BY table_name
    `);
    
    console.log('\nTables containing "idse" or "pfx":\n');
    if (idse_tables.length > 0) {
      idse_tables.forEach((t: any) => console.log(`  - ${t.table_name}`));
    } else {
      console.log('  None found');
    }
    
    // Check clients table columns
    const columns = await query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'clients'
      AND (column_name LIKE '%idse%' OR column_name LIKE '%pfx%')
      ORDER BY column_name
    `);
    
    console.log('\nIDSE-related columns in clients table:\n');
    if (columns.length > 0) {
      columns.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
    } else {
      console.log('  None found');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    const { endPool } = await import('./db');
    await endPool();
  }
}

checkTables();
