// Upload endpoints — mirrors the AWS WebApi cacheXxx + saveCache contract.
//
// POST /api/cache/{table}      body: {
//     processId?:    <guid>,           // omit for first call; server mints one
//     localDatabase: <guid>,
//     rows: [
//       { op: 1|2|3, pk: "<row pk>", record: { ... }, deviceSyncState: <int> }
//     ]
//   }
//   Appends rows to [dbo].[SyncCache] (Status='pending').
//
//   Op codes (the device's intent for this row):
//     1 = insert, 2 = update, 3 = delete, 4 = no-op / clean.
//
//   These are NOT the same as SyncState. SyncState lives ON each real row
//   (Site, Sample, ...) and means:
//     0 = device-edited, needs upload   (device sets when row changes)
//     1 = local-only, never sync        (device draft / scratch)
//     2 = seeded from default DB
//     3 = (legacy; not used here)
//     4 = synced from server            (THIS server stamps after applying)
//
//   Returns the processId so the device threads subsequent cache calls + the
//   final saveCache through it.
//
// POST /api/saveCache          body: { processId: <guid> }
//   Applies all pending SyncCache rows for processId to the real tables in
//   FK-safe order. Each applied row is stamped with SyncState=4 and a fresh
//   SyncKey (epoch milliseconds, monotonic). Per-row outcome lands in
//   [dbo].[SyncCacheLog] so the device can replay status to the user.
//
// GET  /api/viewsavelog/{processId}
//   Returns the SyncCacheLog rows for a processId.

const {randomUUID}=require('crypto');
const {app}=require('@azure/functions');
const {jsonResponse,preflight}=require('./_shared/cors');
const {requireAuth}=require('./_shared/auth');
const {getPool,sql}=require('./_shared/sql');
const {SPECS,APPLY_ORDER}=require('./_shared/tableSpecs');
const {applyPending}=require('./_shared/apply');

// Tables a device is allowed to push. Whitelist defends the dynamic route.
const CACHEABLE_TABLES=new Set([
    'Site','SiteClass','SiteClassLink','Locator','SitePhoto',
    'Protocol','EventGroup','Event','Sample','SampleDatum',
    'PhotoDoc','SpList','SpListLink',
    'Contact','ContactLink','Inquiry','InquiryDatum','Report'
]);

const VALID_OPS=new Set([1,2,3,4]);

function isValidGuid(s) {
    return typeof s==='string'&&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// SyncCache.ProcessId is UNIQUEIDENTIFIER. Devices may pass their own GUID;
// when they don't, mint one client-side here.
function mintProcessId() {
    return randomUUID();
}

app.http('cacheTable',{
    methods: ['POST','OPTIONS'],
    route: 'cache/{table}',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        const table=request.params.table;
        if(!CACHEABLE_TABLES.has(table)) {
            return jsonResponse(400,{error: `Table not cacheable: ${table}`});
        }

        let body;
        try {body=await request.json();}
        catch {return jsonResponse(400,{error: 'Invalid JSON'});}

        const localDatabase=String(body?.localDatabase||'').trim();
        if(!isValidGuid(localDatabase)) {
            return jsonResponse(400,{error: 'Missing or invalid localDatabase (expected GUID)'});
        }

        const rows=Array.isArray(body?.rows)? body.rows:[];
        if(!rows.length) {
            return jsonResponse(400,{error: 'rows[] is required and must be non-empty'});
        }
        for(const r of rows) {
            if(!VALID_OPS.has(Number(r?.op))) {
                return jsonResponse(400,{error: `Invalid op (expected 1|2|3|4): ${r?.op}`});
            }
            if(typeof r?.pk!=='string'||!r.pk) {
                return jsonResponse(400,{error: 'Each row needs a string pk'});
            }
        }

        try {
            const db=await getPool();
            const incomingPid=String(body?.processId||'').trim();
            const processId=isValidGuid(incomingPid)? incomingPid:mintProcessId();

            // Insert rows in a single batch via a table-valued parameter would be
            // ideal; for now do prepared-statement loop to keep this dependency-free.
            let inserted=0;
            for(const r of rows) {
                await db.request()
                    .input('pid',sql.UniqueIdentifier,processId)
                    .input('database',sql.UniqueIdentifier,localDatabase)
                    .input('user_oid',sql.NVarChar(100),auth.user.oid)
                    .input('tbl',sql.NVarChar(64),table)
                    .input('op',sql.Int,Number(r.op))
                    .input('payload',sql.NVarChar(sql.MAX),
                        r.record!=null? JSON.stringify(r.record):'{}')
                    .input('dss',sql.Int,Number.isFinite(Number(r.deviceSyncState))? Number(r.deviceSyncState):null)
                    .query(`
            INSERT INTO [dbo].[SyncCache]
              (ProcessId, [Database], UserOid, TableName, Op, PayloadJson, DeviceSyncState, Status)
            VALUES (@pid, @database, @user_oid, @tbl, @op, @payload, @dss, 'pending');
          `);
                inserted++;
            }

            return jsonResponse(200,{success: true,processId,table,inserted});
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});

app.http('saveCache',{
    methods: ['POST','OPTIONS'],
    route: 'saveCache',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        let body;
        try {body=await request.json();}
        catch {return jsonResponse(400,{error: 'Invalid JSON'});}

        const processId=String(body?.processId||'').trim();
        if(!isValidGuid(processId)) {
            return jsonResponse(400,{error: 'Missing or invalid processId (expected GUID)'});
        }

        try {
            const db=await getPool();
            const result=await applyPending(db,processId,auth.user);
            return jsonResponse(200,{
                success: true,
                processId,
                applied: result.applied,
                skipped: result.skipped,
                failed: result.failed,
                perTable: result.perTable
            });
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});

app.http('viewsavelog',{
    methods: ['GET','OPTIONS'],
    route: 'viewsavelog/{processId}',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        const processId=String(request.params.processId||'').trim();
        if(!isValidGuid(processId)) {
            return jsonResponse(400,{error: 'Invalid processId (expected GUID)'});
        }

        try {
            const db=await getPool();
            const r=await db.request()
                .input('pid',sql.UniqueIdentifier,processId)
                .query(`
          SELECT TOP 5000 PK_SyncCacheLog AS LogId, [Level], TableName, Op, RecordPK, [Message], CreatedAt
          FROM [dbo].[SyncCacheLog]
          WHERE ProcessId = @pid
          ORDER BY PK_SyncCacheLog ASC;
        `);
            return jsonResponse(200,{success: true,processId,entries: r.recordset});
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});
