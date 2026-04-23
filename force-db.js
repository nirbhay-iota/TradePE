const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function forceTables() {
    try {
        console.log("🚀 Connecting directly to Railway...");
        
        // PASTE YOUR EXACT RAILWAY CONNECTION URL HERE
        const connectionUri = "mysql://root:YOUR_PASSWORD@shortline.proxy.rlwy.net:48319/railway"; 
        
        const connection = await mysql.createConnection({
            uri: connectionUri,
            multipleStatements: true // This allows us to run the whole file at once
        });

        console.log("✅ Connected! Reading schema.sql...");
        const schemaPath = path.join(__dirname, 'db', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        console.log("🔨 Forcing table creation...");
        await connection.query(schema);

        console.log("🎉 ALL TABLES CREATED SUCCESSFULLY! You can delete this file now.");
        process.exit(0);
    } catch (err) {
        console.error("❌ ERROR:", err.message);
        process.exit(1);
    }
}

forceTables();
