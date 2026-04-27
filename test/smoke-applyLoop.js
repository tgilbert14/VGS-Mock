// Smoke test for the saveCache apply-loop. Direct DB, no HTTP, no auth.
//
// Run:  node test/smoke-applyLoop.js
//
// What it does:
//   1. Connects to the configured Azure SQL database (env-driven).
//   2. Mints a processId GUID + a fake databaseGuid + two Site PK GUIDs.
//   3. Inserts SyncCache rows simulating a device upload:
//          - Op=1 Site SMOKE-1 (insert)
//          - Op=2 Site SMOKE-1 (update Notes)
//          - Op=1 Site SMOKE-2 (insert)
//          - Op=3 Site SMOKE-2 (delete)
//   4. Calls applyPending() — same module the saveCache HTTP endpoint uses.
//   5. Prints the result + dumps the SyncCacheLog rows for that processId.
//   6. Cleans up: deletes leftover Site SMOKE-1 + the SyncCache + log rows.

const {randomUUID}=require('crypto');
const sql=require('mssql');
const {applyPending}=require('../api/_shared/apply');
const config=require('./_dbConfig');

async function main() {
    const pool=await new sql.ConnectionPool(config).connect();
    console.log('[smoke] connected');

    const processId=randomUUID();
    const databaseGuid=randomUUID();
    const site1Pk=randomUUID();
    const site2Pk=randomUUID();

    console.log('[smoke] processId:',processId);
    console.log('[smoke] site1:',site1Pk);
    console.log('[smoke] site2:',site2Pk);

    // Build the four SyncCache payloads up front.
    const rows=[
        {
            op: 1,
            payload: {
                PK_Site: site1Pk,
                FK_Species_Site: 'SITE_KEY',
                FK_Species_SiteStatus: 'SST_ACTIVE',
                FK_Species_ElevUnits: 'UNIT_FEET',
                SiteID: 'SMOKE-1',
                Alias: 'Smoke 1',
                Notes: 'initial',
                Slope: 5,
                Aspect: 180,
                Elevation: 4500,
                DateEstablished: new Date().toISOString()
            }
        },
        {
            op: 2,
            payload: {
                PK_Site: site1Pk,
                FK_Species_Site: 'SITE_KEY',
                FK_Species_SiteStatus: 'SST_ACTIVE',
                FK_Species_ElevUnits: 'UNIT_FEET',
                SiteID: 'SMOKE-1',
                Alias: 'Smoke 1',
                Notes: 'updated',
                Slope: 5,
                Aspect: 180,
                Elevation: 4500,
                DateEstablished: new Date().toISOString()
            }
        },
        {
            op: 1,
            payload: {
                PK_Site: site2Pk,
                FK_Species_Site: 'SITE_KEY',
                FK_Species_SiteStatus: 'SST_ACTIVE',
                FK_Species_ElevUnits: 'UNIT_FEET',
                SiteID: 'SMOKE-2',
                Alias: 'Smoke 2',
                Notes: 'will be deleted',
                Slope: 0,
                Aspect: 0,
                Elevation: 0,
                DateEstablished: new Date().toISOString()
            }
        },
        {
            op: 3,
            payload: {PK_Site: site2Pk}
        }
    ];

    // Insert the simulated SyncCache batch.
    for(const r of rows) {
        await pool.request()
            .input('pid',sql.UniqueIdentifier,processId)
            .input('database',sql.UniqueIdentifier,databaseGuid)
            .input('user',sql.NVarChar(100),'smoke-test')
            .input('table',sql.NVarChar(64),'Site')
            .input('op',sql.Int,r.op)
            .input('payload',sql.NVarChar(sql.MAX),JSON.stringify(r.payload))
            .input('state',sql.Int,0)
            .query(`
              INSERT INTO [dbo].[SyncCache]
                (ProcessId, [Database], UserOid, TableName, Op, PayloadJson, DeviceSyncState)
              VALUES (@pid, @database, @user, @table, @op, @payload, @state);
            `);
    }
    console.log('[smoke] queued',rows.length,'cache rows');

    // Run the apply.
    const result=await applyPending(pool,processId,{oid: 'smoke-test'});
    console.log('[smoke] applyPending result:');
    console.dir(result,{depth: 4});

    // Show the log entries.
    const log=(await pool.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .query(`
          SELECT [Level], TableName, Op, RecordPK, [Message], CreatedAt
          FROM [dbo].[SyncCacheLog]
          WHERE ProcessId = @pid
          ORDER BY PK_SyncCacheLog;
        `)).recordset;
    console.log('[smoke] SyncCacheLog rows:');
    for(const l of log) {
        console.log(`  [${l.Level}] ${l.TableName} op=${l.Op} pk=${l.RecordPK} → ${l.Message}`);
    }

    // Verify Site state in DB.
    const sites=(await pool.request()
        .input('a',sql.UniqueIdentifier,site1Pk)
        .input('b',sql.UniqueIdentifier,site2Pk)
        .query(`
          SELECT PK_Site, SiteID, Notes, SyncKey, SyncState
          FROM [dbo].[Site]
          WHERE PK_Site IN (@a,@b);
        `)).recordset;
    console.log('[smoke] Site rows after apply:');
    for(const s of sites) {
        console.log(`  ${s.SiteID}: notes="${s.Notes}" syncKey=${s.SyncKey} syncState=${s.SyncState}`);
    }

    // Cleanup: delete the surviving site, then the cache + log rows.
    await pool.request()
        .input('pk',sql.UniqueIdentifier,site1Pk)
        .query(`DELETE FROM [dbo].[Site] WHERE PK_Site = @pk;`);
    await pool.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .query(`
          DELETE FROM [dbo].[SyncCacheLog] WHERE ProcessId = @pid;
          DELETE FROM [dbo].[SyncCache]    WHERE ProcessId = @pid;
        `);
    console.log('[smoke] cleanup complete');

    await pool.close();
}

main().catch(err => {
    console.error('[smoke] FAILED:',err);
    process.exit(1);
});
