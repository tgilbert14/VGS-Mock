// Sync metadata endpoints — mirrors the AWS WebApi contract.
//
// POST /api/syncexchange     body: { localDatabase: <guid> }
//   Registers (or refreshes) the device in dbo.SyncTracking and returns the
//   per-table SyncKey high-water-mark for that device. Device uses these
//   values to decide what to upload (rows whose local SyncState > 0).
//
// POST /api/getlastsynckey   body: { localDatabase: <guid>, tables?: string[] }
//   Returns max(SyncKey) across the selected real tables (Site, SiteClass,
//   Event, Sample, ...) — used by the device after a download to know what
//   to put in its own SyncTracking row.

const {app}=require('@azure/functions');
const {jsonResponse,preflight}=require('./_shared/cors');
const {requireAuth}=require('./_shared/auth');
const {getPool,sql}=require('./_shared/sql');

// Tables whose SyncKey the device cares about. Order doesn't matter here.
const SYNCED_TABLES=[
    'Site','SiteClass','SiteClassLink','Locator','SitePhoto',
    'Protocol','EventGroup','Event','Sample','SampleDatum',
    'PhotoDoc','SpList','SpListLink','Species','TypeList','SubTypeList',
    'Contact','ContactLink','Inquiry','InquiryDatum','Report'
];

function isValidGuid(s) {
    return typeof s==='string'&&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function getMaxSyncKeys(db,tables) {
    // Build a single query: SELECT MAX(SyncKey) AS [Site] FROM Site, ...
    const selects=tables.map(t => `(SELECT ISNULL(MAX(SyncKey), 0) FROM [dbo].[${t}]) AS [${t}]`);
    const result=await db.request().query(`SELECT ${selects.join(', ')}`);
    return result.recordset[0]||{};
}

app.http('syncexchange',{
    methods: ['POST','OPTIONS'],
    route: 'syncexchange',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        let body;
        try {body=await request.json();}
        catch {return jsonResponse(400,{error: 'Invalid JSON'});}

        const localDatabase=String(body?.localDatabase||'').trim();
        if(!isValidGuid(localDatabase)) {
            return jsonResponse(400,{error: 'Missing or invalid localDatabase (expected GUID)'});
        }

        try {
            const db=await getPool();
            // Upsert SyncTracking row for this device.
            // Real columns: PK_SyncTracking, Database, Status, Key, Schema.
            // Stash auth oid + last-seen timestamp in Status as 'oid|isoTime'.
            const statusValue=`${auth.user.oid}|${new Date().toISOString()}`;
            await db.request()
                .input('database',sql.UniqueIdentifier,localDatabase)
                .input('status',sql.NVarChar(50),statusValue.slice(0,50))
                .query(`
          MERGE [dbo].[SyncTracking] AS t
          USING (SELECT @database AS [Database]) AS s
          ON t.[Database] = s.[Database]
          WHEN MATCHED THEN
            UPDATE SET [Status] = @status
          WHEN NOT MATCHED THEN
            INSERT ([PK_SyncTracking], [Database], [Status], [Key], [Schema])
            VALUES (NEWID(), s.[Database], @status, 0, NULL);
        `);

            const syncKeys=await getMaxSyncKeys(db,SYNCED_TABLES);
            return jsonResponse(200,{
                success: true,
                localDatabase,
                serverTime: new Date().toISOString(),
                syncKeys
            });
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});

app.http('getlastsynckey',{
    methods: ['POST','OPTIONS'],
    route: 'getlastsynckey',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        let body={};
        try {body=await request.json();} catch { /* allow empty body */}

        const requested=Array.isArray(body?.tables)&&body.tables.length
            ? body.tables.filter(t => SYNCED_TABLES.includes(t))
            :SYNCED_TABLES;

        if(!requested.length) {
            return jsonResponse(400,{error: 'No valid tables requested'});
        }

        try {
            const db=await getPool();
            const syncKeys=await getMaxSyncKeys(db,requested);
            return jsonResponse(200,{success: true,syncKeys});
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});
