// Azure Function: POST /api/observations
// Runtime: Node.js 18+ (v4 programming model)
//
// SETUP:
//  1. Create an Azure Function App (Node.js 18+)
//  2. Add these Application Settings (Environment Variables):
//       SQL_SERVER   = timbo-server-1.database.windows.net
//       SQL_DATABASE = vgsMockdb
//       SQL_USER     = your-sql-user
//       SQL_PASSWORD = your-sql-password
//  3. Deploy this file as the function
//  4. Paste the function URL into the app's Settings panel

const {app}=require('@azure/functions');
const sql=require('mssql');

// SQL connection pool (reused across warm invocations)
let pool=null;

async function getPool() {
  if(pool) return pool;
  pool=await sql.connect({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
      encrypt: true,           // Required for Azure SQL
      trustServerCertificate: false
    }
  });
  return pool;
}

// ── Ensure table exists ────────────────────────────────────────────────────────
// Run this once manually in your Azure SQL database, or let the function
// auto-create it on first call (handled below).
const CREATE_TABLE_SQL=`
IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='observations' AND xtype='U'
)
CREATE TABLE observations (
  id            NVARCHAR(50)   PRIMARY KEY,
  recorded_at   DATETIME2      NOT NULL,
  synced_at     DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  note          NVARCHAR(MAX)  NOT NULL,
  latitude      FLOAT          NULL,
  longitude     FLOAT          NULL,
  accuracy_m    FLOAT          NULL,
  photo_base64  NVARCHAR(MAX)  NULL
);
`;

// ── Function handler ───────────────────────────────────────────────────────────
app.http('observations',{
  methods: ['POST'],
  authLevel: 'function',   // Requires x-functions-key header
  handler: async (request,context) => {

    // Parse body
    let body;
    try {
      body=await request.json();
    } catch {
      return {status: 400,body: JSON.stringify({error: 'Invalid JSON'})};
    }

    const {id,timestamp,note,latitude,longitude,accuracy,photo_base64}=body;

    // Basic validation
    if(!id||!timestamp||!note) {
      return {
        status: 400,
        body: JSON.stringify({error: 'Missing required fields: id, timestamp, note'})
      };
    }

    try {
      const db=await getPool();

      // Auto-create table if needed
      await db.request().query(CREATE_TABLE_SQL);

      // Upsert so retries are safe (idempotent)
      await db.request()
        .input('id',sql.NVarChar(50),id)
        .input('recorded_at',sql.DateTime2,new Date(timestamp))
        .input('note',sql.NVarChar(sql.MAX),note)
        .input('latitude',sql.Float,latitude??null)
        .input('longitude',sql.Float,longitude??null)
        .input('accuracy_m',sql.Float,accuracy??null)
        .input('photo_base64',sql.NVarChar(sql.MAX),photo_base64??null)
        .query(`
          MERGE observations AS target
          USING (VALUES (
            @id, @recorded_at, @note, @latitude, @longitude, @accuracy_m, @photo_base64
          )) AS source (id, recorded_at, note, latitude, longitude, accuracy_m, photo_base64)
          ON target.id = source.id
          WHEN NOT MATCHED THEN
            INSERT (id, recorded_at, note, latitude, longitude, accuracy_m, photo_base64)
            VALUES (source.id, source.recorded_at, source.note, source.latitude,
                    source.longitude, source.accuracy_m, source.photo_base64);
        `);

      context.log(`Saved observation ${id}`);
      return {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({success: true,id})
      };

    } catch(err) {
      context.log.error('DB error:',err.message);
      return {
        status: 500,
        body: JSON.stringify({error: 'Database error',detail: err.message})
      };
    }
  }
});
