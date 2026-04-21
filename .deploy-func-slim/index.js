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
const {createRemoteJWKSet,jwtVerify}=require('jose');

const ALLOWED_ORIGIN='https://tgilbert14.github.io';
const AUTH_TENANT_ID=process.env.AUTH_TENANT_ID||'48daa81b-c1eb-4526-9ea1-66b60398179a';
const AUTH_CLIENT_ID=process.env.AUTH_CLIENT_ID||'025d2544-3267-47a5-a97d-261ae4e741fd';
const AUTH_AUTHORITY_HOST=process.env.AUTH_AUTHORITY_HOST||'ecoplot.ciamlogin.com';
const REQUIRE_USER_APPROVAL=['1','true','yes'].includes(String(process.env.REQUIRE_USER_APPROVAL||'').toLowerCase());
const ADMIN_USER_OIDS=new Set(String(process.env.ADMIN_USER_OIDS||'').split(',').map(v => v.trim()).filter(Boolean));
const JWKS=createRemoteJWKSet(new URL(`https://${AUTH_AUTHORITY_HOST}/${AUTH_TENANT_ID}/discovery/v2.0/keys`));
const VALID_AUDIENCES=[AUTH_CLIENT_ID,`api://${AUTH_CLIENT_ID}`];

const CORS_HEADERS={
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-functions-key'
};

function jsonResponse(status,payload) {
  return {
    status,
    headers: {'Content-Type': 'application/json',...CORS_HEADERS},
    body: JSON.stringify(payload)
  };
}

function getHeader(request,name) {
  return request.headers?.get?.(name)
    ||request.headers?.get?.(name.toLowerCase())
    ||request.headers?.[name]
    ||request.headers?.[name.toLowerCase()]
    ||'';
}

async function verifyAccessToken(request) {
  const authHeader=getHeader(request,'authorization');
  if(!authHeader||!authHeader.startsWith('Bearer ')) {
    return {ok: false,status: 401,error: 'Missing bearer token'};
  }

  try {
    const token=authHeader.slice('Bearer '.length).trim();
    const {payload}=await jwtVerify(token,JWKS,{audience: VALID_AUDIENCES});
    if(payload.tid!==AUTH_TENANT_ID) {
      return {ok: false,status: 401,error: 'Unexpected tenant',detail: `Token tid ${payload.tid||'missing'} did not match expected tenant.`};
    }

    const issuer=String(payload.iss||'');
    let issuerMatchesAuthority=false;
    try {
      const issuerUrl=new URL(issuer);
      const host=issuerUrl.hostname.toLowerCase();
      const path=issuerUrl.pathname.toLowerCase();
      const tenantSegment=`/${AUTH_TENANT_ID.toLowerCase()}/`;
      const isCiamHost=host===AUTH_AUTHORITY_HOST.toLowerCase()||host.endsWith('.ciamlogin.com');
      const isMicrosoftHost=host==='login.microsoftonline.com'||host==='sts.windows.net';
      issuerMatchesAuthority=(isCiamHost||isMicrosoftHost)&&path.includes(tenantSegment);
    } catch {
      issuerMatchesAuthority=false;
    }
    if(!issuerMatchesAuthority) {
      return {ok: false,status: 401,error: 'Unexpected issuer',detail: `Unexpected token issuer: ${issuer||'missing'}`};
    }

    const userOid=payload.oid||payload.sub||null;
    if(!userOid) {
      return {ok: false,status: 401,error: 'Token missing user identifier'};
    }
    return {
      ok: true,
      user: {
        oid: userOid,
        email: payload.preferred_username||payload.email||payload.upn||null,
        displayName: payload.name||null
      }
    };
  } catch(err) {
    return {ok: false,status: 401,error: 'Invalid bearer token',detail: err.message};
  }
}

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
  submitted_by_oid   NVARCHAR(100)  NULL,
  submitted_by_email NVARCHAR(255)  NULL,
  submitted_by_name  NVARCHAR(255)  NULL,
  frame_w        FLOAT          NULL,
  frame_h        FLOAT          NULL,
  species        NVARCHAR(MAX)  NULL,
  cover_hits     NVARCHAR(MAX)  NULL,
  fetch_data     NVARCHAR(MAX)  NULL
);
`;

const ENSURE_OBSERVATION_COLUMNS_SQL=`
IF COL_LENGTH('observations','submitted_by_oid') IS NULL
  ALTER TABLE observations ADD submitted_by_oid NVARCHAR(100) NULL;
IF COL_LENGTH('observations','submitted_by_email') IS NULL
  ALTER TABLE observations ADD submitted_by_email NVARCHAR(255) NULL;
IF COL_LENGTH('observations','submitted_by_name') IS NULL
  ALTER TABLE observations ADD submitted_by_name NVARCHAR(255) NULL;
`;

const CREATE_APPROVED_USERS_SQL=`
IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='approved_users' AND xtype='U'
)
CREATE TABLE approved_users (
  user_oid      NVARCHAR(100)  PRIMARY KEY,
  email         NVARCHAR(255)  NULL,
  display_name  NVARCHAR(255)  NULL,
  is_approved   BIT            NOT NULL DEFAULT 0,
  is_admin      BIT            NOT NULL DEFAULT 0,
  requested_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  approved_at   DATETIME2      NULL,
  last_seen_at  DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
`;

const ENSURE_APPROVED_USERS_COLUMNS_SQL=`
IF COL_LENGTH('approved_users','is_admin') IS NULL
  ALTER TABLE approved_users ADD is_admin BIT NOT NULL DEFAULT 0;
`;

async function ensureApprovalTables(db) {
  await db.request().query(CREATE_APPROVED_USERS_SQL);
  await db.request().query(ENSURE_APPROVED_USERS_COLUMNS_SQL);
}

function isConfiguredAdmin(user) {
  return ADMIN_USER_OIDS.has(String(user?.oid||''));
}

async function upsertApprovalRequest(db,user) {
  const countResult=await db.request().query(`
    SELECT COUNT(*) AS approved_count
    FROM approved_users
    WHERE is_approved = 1
  `);
  const autoApproveFirstUser=(countResult.recordset[0]?.approved_count||0)===0;
  const adminCountResult=await db.request().query(`
    SELECT COUNT(*) AS admin_count
    FROM approved_users
    WHERE is_admin = 1
  `);
  const autoAdminFirstUser=(adminCountResult.recordset[0]?.admin_count||0)===0;
  const configuredAdmin=isConfiguredAdmin(user);

  const result=await db.request()
    .input('user_oid',sql.NVarChar(100),user.oid)
    .input('email',sql.NVarChar(255),user.email??null)
    .input('display_name',sql.NVarChar(255),user.displayName??null)
    .input('auto_approve',sql.Bit,autoApproveFirstUser)
    .input('auto_admin',sql.Bit,autoAdminFirstUser||configuredAdmin)
    .query(`
      MERGE approved_users AS target
      USING (
        SELECT @user_oid AS user_oid,
               @email AS email,
               @display_name AS display_name,
               @auto_approve AS auto_approve,
               @auto_admin AS auto_admin
      ) AS source
      ON target.user_oid = source.user_oid
      WHEN MATCHED THEN
        UPDATE SET
          email = source.email,
          display_name = source.display_name,
          last_seen_at = SYSUTCDATETIME(),
          is_approved = CASE
            WHEN target.is_approved = 1 OR source.auto_approve = 1 THEN 1
            ELSE 0
          END,
          is_admin = CASE
            WHEN target.is_admin = 1 OR source.auto_admin = 1 THEN 1
            ELSE 0
          END,
          approved_at = CASE
            WHEN target.approved_at IS NOT NULL THEN target.approved_at
            WHEN source.auto_approve = 1 THEN SYSUTCDATETIME()
            ELSE NULL
          END
      WHEN NOT MATCHED THEN
        INSERT (user_oid,email,display_name,is_approved,is_admin,requested_at,approved_at,last_seen_at)
        VALUES (
          source.user_oid,
          source.email,
          source.display_name,
          CASE WHEN source.auto_approve = 1 THEN 1 ELSE 0 END,
          CASE WHEN source.auto_admin = 1 THEN 1 ELSE 0 END,
          SYSUTCDATETIME(),
          CASE WHEN source.auto_approve = 1 THEN SYSUTCDATETIME() ELSE NULL END,
          SYSUTCDATETIME()
        );

      SELECT TOP 1 user_oid,email,display_name,is_approved,is_admin,requested_at,approved_at,last_seen_at
      FROM approved_users
      WHERE user_oid = @user_oid;
    `);

  return result.recordset[0]||null;
}

async function isAdminUser(db,user) {
  if(isConfiguredAdmin(user)) return true;
  const result=await db.request()
    .input('user_oid',sql.NVarChar(100),user.oid)
    .query(`
      SELECT TOP 1 is_admin
      FROM approved_users
      WHERE user_oid = @user_oid
    `);
  return !!result.recordset[0]?.is_admin;
}

// ── Function handler ───────────────────────────────────────────────────────────
app.http('observations',{
  methods: ['POST','OPTIONS'],
  authLevel: 'function',
  handler: async (request,context) => {

    // Handle CORS preflight
    if((request.method||'').toUpperCase()==='OPTIONS') {
      return {status: 204,headers: CORS_HEADERS,body: ''};
    }

    const tokenResult=await verifyAccessToken(request);
    if(!tokenResult.ok) {
      return jsonResponse(tokenResult.status,{
        error: tokenResult.error,
        detail: tokenResult.detail||null
      });
    }

    // Parse body
    let body;
    try {
      body=await request.json();
    } catch {
      return jsonResponse(400,{error: 'Invalid JSON'});
    }

    const {id,siteId,siteName,transectIdx,sampleIdx,savedAt,
      species,coverHits,fetch: fetchData,eventId,frameW,frameH}=body;

    if(!id||!savedAt) {
      return jsonResponse(400,{error: 'Missing required fields: id, savedAt'});
    }

    try {
      const db=await getPool();

      await db.request().query(CREATE_TABLE_SQL);
      await db.request().query(ENSURE_OBSERVATION_COLUMNS_SQL);
      await ensureApprovalTables(db);

      const approval=await upsertApprovalRequest(db,tokenResult.user);
      if(REQUIRE_USER_APPROVAL&&!approval?.is_approved&&!isConfiguredAdmin(tokenResult.user)) {
        return jsonResponse(403,{
          error: 'Approval required',
          detail: 'Your account is pending approval for sync access.',
          user: {
            oid: tokenResult.user.oid,
            email: tokenResult.user.email,
            displayName: tokenResult.user.displayName
          }
        });
      }

      await db.request()
        .input('id',sql.NVarChar(100),id)
        .input('site_id',sql.NVarChar(100),siteId??null)
        .input('site_name',sql.NVarChar(255),siteName??null)
        .input('transect_idx',sql.Int,transectIdx??null)
        .input('sample_idx',sql.Int,sampleIdx??null)
        .input('recorded_at',sql.DateTime2,new Date(savedAt))
        .input('event_id',sql.NVarChar(100),eventId??null)
        .input('submitted_by_oid',sql.NVarChar(100),tokenResult.user.oid)
        .input('submitted_by_email',sql.NVarChar(255),tokenResult.user.email??null)
        .input('submitted_by_name',sql.NVarChar(255),tokenResult.user.displayName??null)
        .input('frame_w',sql.Float,frameW??null)
        .input('frame_h',sql.Float,frameH??null)
        .input('species',sql.NVarChar(sql.MAX),species!=null? JSON.stringify(species):null)
        .input('cover_hits',sql.NVarChar(sql.MAX),coverHits!=null? JSON.stringify(coverHits):null)
        .input('fetch_data',sql.NVarChar(sql.MAX),fetchData!=null? JSON.stringify(fetchData):null)
        .query(`
          MERGE observations AS target
          USING (VALUES (
            @id,@site_id,@site_name,@transect_idx,@sample_idx,@recorded_at,
            @event_id,@submitted_by_oid,@submitted_by_email,@submitted_by_name,
            @frame_w,@frame_h,@species,@cover_hits,@fetch_data
          )) AS source (id,site_id,site_name,transect_idx,sample_idx,recorded_at,
            event_id,submitted_by_oid,submitted_by_email,submitted_by_name,
            frame_w,frame_h,species,cover_hits,fetch_data)
          ON target.id = source.id
          WHEN NOT MATCHED THEN
            INSERT (id,site_id,site_name,transect_idx,sample_idx,recorded_at,
              event_id,submitted_by_oid,submitted_by_email,submitted_by_name,
              frame_w,frame_h,species,cover_hits,fetch_data)
            VALUES (source.id,source.site_id,source.site_name,source.transect_idx,
              source.sample_idx,source.recorded_at,source.event_id,source.submitted_by_oid,
              source.submitted_by_email,source.submitted_by_name,source.frame_w,
              source.frame_h,source.species,source.cover_hits,source.fetch_data);
        `);

      context.log(`Saved observation ${id}`);
      return jsonResponse(200,{
        success: true,
        id,
        approvedUser: !!approval?.is_approved,
        adminUser: !!approval?.is_admin,
        submittedBy: tokenResult.user.email||tokenResult.user.oid
      });

    } catch(err) {
      context.log.error('DB error:',err.message);
      return jsonResponse(500,{error: 'Database error',detail: err.message});
    }
  }
});

app.http('approvals',{
  methods: ['GET','POST','OPTIONS'],
  authLevel: 'function',
  handler: async (request) => {
    if((request.method||'').toUpperCase()==='OPTIONS') {
      return {status: 204,headers: CORS_HEADERS,body: ''};
    }

    const tokenResult=await verifyAccessToken(request);
    if(!tokenResult.ok) {
      return jsonResponse(tokenResult.status,{error: tokenResult.error,detail: tokenResult.detail||null});
    }

    try {
      const db=await getPool();
      await ensureApprovalTables(db);
      await upsertApprovalRequest(db,tokenResult.user);

      const callerIsAdmin=await isAdminUser(db,tokenResult.user);
      if(!callerIsAdmin) {
        return jsonResponse(403,{error: 'Admin required',detail: 'Only admins can review approvals.'});
      }

      if((request.method||'').toUpperCase()==='GET') {
        const usersResult=await db.request().query(`
          SELECT TOP 200
            user_oid AS userOid,
            email,
            display_name AS displayName,
            is_approved AS isApproved,
            is_admin AS isAdmin,
            requested_at AS requestedAt,
            approved_at AS approvedAt,
            last_seen_at AS lastSeenAt
          FROM approved_users
          ORDER BY is_approved ASC, requested_at DESC
        `);
        return jsonResponse(200,{success: true,users: usersResult.recordset||[]});
      }

      let body;
      try {
        body=await request.json();
      } catch {
        return jsonResponse(400,{error: 'Invalid JSON'});
      }

      const userOid=String(body?.userOid||'').trim();
      const approve=!!body?.approve;
      if(!userOid) {
        return jsonResponse(400,{error: 'Missing required field: userOid'});
      }

      const updatedResult=await db.request()
        .input('user_oid',sql.NVarChar(100),userOid)
        .input('approve',sql.Bit,approve)
        .query(`
          UPDATE approved_users
          SET
            is_approved = @approve,
            approved_at = CASE WHEN @approve = 1 THEN SYSUTCDATETIME() ELSE NULL END
          WHERE user_oid = @user_oid;

          SELECT TOP 1
            user_oid AS userOid,
            email,
            display_name AS displayName,
            is_approved AS isApproved,
            is_admin AS isAdmin,
            requested_at AS requestedAt,
            approved_at AS approvedAt,
            last_seen_at AS lastSeenAt
          FROM approved_users
          WHERE user_oid = @user_oid;
        `);

      const updated=updatedResult.recordset[0]||null;
      if(!updated) {
        return jsonResponse(404,{error: 'User not found in approvals table'});
      }

      return jsonResponse(200,{success: true,user: updated});
    } catch(err) {
      return jsonResponse(500,{error: 'Database error',detail: err.message});
    }
  }
});
