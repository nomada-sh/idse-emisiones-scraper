import { query } from './db';

async function checkPFXFiles() {
  console.log('\n=== Checking PFX Files in Database ===\n');
  
  try {
    // Check files_related_morphs structure
    const morphColumns = await query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'files_related_morphs'
      ORDER BY column_name
    `);
    
    console.log('Columns in files_related_morphs:\n');
    morphColumns.forEach((c: any) => console.log(`  - ${c.column_name} (${c.data_type})`));
    
    // Check for PFX files related to clients
    const pfxFiles = await query(`
      SELECT 
        f.id,
        f.name,
        f.url,
        frm.related_id as client_id,
        frm.field,
        c.business_name
      FROM files f
      INNER JOIN files_related_morphs frm ON f.id = frm.file_id
      INNER JOIN clients c ON c.id = frm.related_id
      WHERE frm.related_type = 'api::client.client'
      AND (frm.field LIKE '%idse%' OR frm.field LIKE '%pfx%' OR f.name LIKE '%.pfx' OR f.name LIKE '%.p12')
      LIMIT 10
    `);
    
    console.log('\nPFX files linked to clients:\n');
    if (pfxFiles.length > 0) {
      pfxFiles.forEach((f: any) => {
        console.log(`  Client: ${f.business_name} (ID: ${f.client_id})`);
        console.log(`    File: ${f.name}`);
        console.log(`    Field: ${f.field}`);
        console.log(`    URL: ${f.url}\n`);
      });
    } else {
      console.log('  No PFX files found\n');
      
      // Check all fields used for client files
      const clientFields = await query(`
        SELECT DISTINCT field
        FROM files_related_morphs
        WHERE related_type = 'api::client.client'
        ORDER BY field
      `);
      
      console.log('Available file fields for clients:\n');
      clientFields.forEach((f: any) => console.log(`  - ${f.field}`));
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    const { endPool } = await import('./db');
    await endPool();
  }
}

checkPFXFiles();
