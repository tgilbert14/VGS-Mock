// Shared SQL connection pool. Reused across warm Function invocations.

const sql=require('mssql');

let pool=null;

async function getPool() {
    if(pool) return pool;
    pool=await sql.connect({
        server: process.env.SQL_SERVER,
        database: process.env.SQL_DATABASE,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        options: {
            encrypt: true,
            trustServerCertificate: false
        }
    });
    return pool;
}

module.exports={getPool,sql};
