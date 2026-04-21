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

const ALLOWED_ORIGIN='https://tgilbert14.github.io';

const CORS_HEADERS={
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-functions-key'
};

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
      encrypt: true,
      trustServerCertificate: false
    }
  });
  return pool;
}

const CREATE_TABLE_SQL=`
IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='observations' AND xtype='U'
)
CREATE TABLE observations (
  id             NVARCHAR(100)  PRIMARY KEY,
  site_id        NVARCHAR(100)  NULL,
  site_name      NVARCHAR(255)  NULL,
  transect_idx   INT            NULL,
  sample_idx     INT            NULL,
  recorded_at    DATETIME2      NOT NULL,
  synced_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  event_id       NVARCHAR(100)  NULL,
  frame_w        FLOAT          NULL,
  frame_h        FLOAT          NULL,
  species        NVARCHAR(MAX)  NULL,
  cover_hits     NVARCHAR(MAX)  NULL,
  fetch_data     NVARCHAR(MAX)  NULL
);
`;

// ── Function handler ───────────────────────────────────────────────────────────
app.http('observations',{
  methods: ['POST','OPTIONS'],
  authLevel: 'function',
  handler: async (request,context) => {

    // Handle CORS preflight
    if((request.method||'').toUpperCase()==='OPTIONS') {
      return {status: 204,headers: CORS_HEADERS,body: ''};
    }

    // Parse body
    let body;
    try {
      body=await request.json();
    } catch {
      return {status: 400,headers: CORS_HEADERS,body: JSON.stringify({error: 'Invalid JSON'})};
    }

    const {id,siteId,siteName,transectIdx,sampleIdx,savedAt,
      species,coverHits,fetch: fetchData,eventId,frameW,frameH}=body;

    if(!id||!savedAt) {
      return {
        status: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({error: 'Missing required fields: id, savedAt'})
      };
    }

    try {
      const db=await getPool();

      await db.request().query(CREATE_TABLE_SQL);

      await db.request()
        .input('id',sql.NVarChar(100),id)
        .input('site_id',sql.NVarChar(100),siteId??null)
        .input('site_name',sql.NVarChar(255),siteName??null)
        .input('transect_idx',sql.Int,transectIdx??null)
        .input('sample_idx',sql.Int,sampleIdx??null)
        .input('recorded_at',sql.DateTime2,new Date(savedAt))
        .input('event_id',sql.NVarChar(100),eventId??null)
        .input('frame_w',sql.Float,frameW??null)
        .input('frame_h',sql.Float,frameH??null)
        .input('species',sql.NVarChar(sql.MAX),species!=null? JSON.stringify(species):null)
        .input('cover_hits',sql.NVarChar(sql.MAX),coverHits!=null? JSON.stringify(coverHits):null)
        .input('fetch_data',sql.NVarChar(sql.MAX),fetchData!=null? JSON.stringify(fetchData):null)
        .query(`
          MERGE observations AS target
          USING (VALUES (
            @id,@site_id,@site_name,@transect_idx,@sample_idx,@recorded_at,
            @event_id,@frame_w,@frame_h,@species,@cover_hits,@fetch_data
          )) AS source (id,site_id,site_name,transect_idx,sample_idx,recorded_at,
            event_id,frame_w,frame_h,species,cover_hits,fetch_data)
          ON target.id = source.id
          WHEN NOT MATCHED THEN
            INSERT (id,site_id,site_name,transect_idx,sample_idx,recorded_at,
              event_id,frame_w,frame_h,species,cover_hits,fetch_data)
            VALUES (source.id,source.site_id,source.site_name,source.transect_idx,
              source.sample_idx,source.recorded_at,source.event_id,source.frame_w,
              source.frame_h,source.species,source.cover_hits,source.fetch_data);
        `);

      context.log(`Saved observation ${id}`);
      return {
        status: 200,
        headers: {'Content-Type': 'application/json',...CORS_HEADERS},
        body: JSON.stringify({success: true,id})
      };

    } catch(err) {
      context.log.error('DB error:',err.message);
      return {
        status: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({error: 'Database error',detail: err.message})
      };
    }
  }
});
