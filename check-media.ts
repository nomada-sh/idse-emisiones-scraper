import { query } from './db';

async function checkMediaStructure() {
  console.log('\n=== Checking Media/Files Structure ===\n');
  
  try {
    // Check for files table
    const files = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND (table_name LIKE '%file%' OR table_name LIKE '%media%' OR table_name LIKE '%upload%')
      ORDER BY table_name
    `);
    
    console.log('Tables related to files/media:\n');
    files.forEach((t: any) => console.log(`  - ${t.table_name}`));
    
    // Check for link tables with clients and files
    const links = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_name LIKE 'clients_%'
      AND (table_name LIKE '%file%' OR table_name LIKE '%media%' OR 
           table_name LIKE '%cer%' OR table_name LIKE '%key%' OR
           table_name LIKE '%signature%' OR table_name LIKE '%logo%')
      ORDER BY table_name
    `);
    
    console.log('\nClient-related file link tables:\n');
    if (links.length > 0) {
      links.forEach((t: any) => console.log(`  - ${t.table_name}`));
    } else {
      console.log('  None found');
    }
    
    // Check the structure of files table if it exists
    const fileColumns = await query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'files'
      LIMIT 10
    `);
    
    console.log('\nColumns in "files" table:\n');
    if (fileColumns.length > 0) {
      fileColumns.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    const { endPool } = await import('./db');
    await endPool();
  }
}

checkMediaStructure();
