// Smoke test for the apply-loop FK chain:
//   Site → Protocol → EventGroup → Event → Sample
//
// Run: node test/smoke-chain.js
//
// All five rows go in as a single SyncCache batch (Op=1) — APPLY_ORDER must
// place them in the correct order so FKs resolve. Then we issue a second batch
// of Op=3 deletes in reverse order to clean up.
//
// Uses TypeList GUID 'Gap Intercept' (ACD1834A-…) for FK_Type_Event /
// FK_Type_EventGroup / FK_Type_Protocol — already seeded by db/seed-typelist.sql.

const {randomUUID}=require('crypto');
const sql=require('mssql');
const {applyPending}=require('../api/_shared/apply');

const config=require('./_dbConfig');

const TYPE_GAP_INTERCEPT='ACD1834A-5531-4D4C-AB94-8BB1D1F627D8';

async function queueRow(pool,processId,databaseGuid,table,op,payload) {
    await pool.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .input('database',sql.UniqueIdentifier,databaseGuid)
        .input('user',sql.NVarChar(100),'smoke-chain')
        .input('table',sql.NVarChar(64),table)
        .input('op',sql.Int,op)
        .input('payload',sql.NVarChar(sql.MAX),JSON.stringify(payload))
        .input('state',sql.Int,0)
        .query(`
          INSERT INTO [dbo].[SyncCache]
            (ProcessId, [Database], UserOid, TableName, Op, PayloadJson, DeviceSyncState)
          VALUES (@pid, @database, @user, @table, @op, @payload, @state);
        `);
}

async function dumpLog(pool,processId,label) {
    const log=(await pool.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .query(`
          SELECT [Level], TableName, Op, RecordPK, [Message]
          FROM [dbo].[SyncCacheLog]
          WHERE ProcessId = @pid
          ORDER BY PK_SyncCacheLog;
        `)).recordset;
    console.log(`[smoke] log (${label}):`);
    for(const l of log) {
        console.log(`  [${l.Level}] ${l.TableName} op=${l.Op} pk=${l.RecordPK} → ${l.Message}`);
    }
}

async function main() {
    const pool=await new sql.ConnectionPool(config).connect();
    console.log('[smoke] connected');

    const databaseGuid=randomUUID();
    const sitePk=randomUUID();
    const protocolPk=randomUUID();
    const eventGroupPk=randomUUID();
    const eventPk=randomUUID();
    const samplePk=randomUUID();

    console.log('[smoke] db:        ',databaseGuid);
    console.log('[smoke] site:      ',sitePk);
    console.log('[smoke] protocol:  ',protocolPk);
    console.log('[smoke] eventGroup:',eventGroupPk);
    console.log('[smoke] event:     ',eventPk);
    console.log('[smoke] sample:    ',samplePk);

    // ── Batch 1: insert the whole chain in one apply call.
    const insertProcess=randomUUID();
    console.log('\n[smoke] === insert batch ===');
    console.log('[smoke] processId:',insertProcess);

    await queueRow(pool,insertProcess,databaseGuid,'Site',1,{
        PK_Site: sitePk,
        FK_Species_Site: 'SITE_KEY',
        FK_Species_SiteStatus: 'SST_ACTIVE',
        FK_Species_ElevUnits: 'UNIT_FEET',
        SiteID: 'CHAIN-1',
        Notes: 'chain-test site'
    });
    await queueRow(pool,insertProcess,databaseGuid,'Protocol',1,{
        PK_Protocol: protocolPk,
        FK_Type_Protocol: TYPE_GAP_INTERCEPT,
        Bailiwick: 'SMOKE',
        ProtocolName: 'Chain Smoke Protocol',
        Date: new Date().toISOString(),
        Notes: 'apply-loop chain test'
    });
    await queueRow(pool,insertProcess,databaseGuid,'EventGroup',1,{
        PK_EventGroup: eventGroupPk,
        FK_Type_EventGroup: TYPE_GAP_INTERCEPT,
        FK_Protocol: protocolPk,
        GroupName: 'Chain EG',
        DisplayOrder: 1
    });
    await queueRow(pool,insertProcess,databaseGuid,'Event',1,{
        PK_Event: eventPk,
        FK_Type_Event: TYPE_GAP_INTERCEPT,
        FK_Site: sitePk,
        FK_EventGroup: eventGroupPk,
        EventName: 'Chain Event',
        PageNumber: 1,
        EntryOrder: 1
    });
    await queueRow(pool,insertProcess,databaseGuid,'Sample',1,{
        PK_Sample: samplePk,
        FK_Event: eventPk,
        FK_Species: null,
        Transect: 1,
        SampleNumber: 1,
        cValue: 'first sample'
    });

    const insertResult=await applyPending(pool,insertProcess,{oid: 'smoke-chain'});
    console.log('[smoke] insert result:');
    console.dir(insertResult,{depth: 4});
    await dumpLog(pool,insertProcess,'insert');

    // Quick verification.
    const counts=(await pool.request()
        .input('site',sql.UniqueIdentifier,sitePk)
        .input('proto',sql.UniqueIdentifier,protocolPk)
        .input('eg',sql.UniqueIdentifier,eventGroupPk)
        .input('ev',sql.UniqueIdentifier,eventPk)
        .input('sa',sql.UniqueIdentifier,samplePk)
        .query(`
          SELECT
            (SELECT COUNT(*) FROM [dbo].[Site]       WHERE PK_Site=@site)    AS sites,
            (SELECT COUNT(*) FROM [dbo].[Protocol]   WHERE PK_Protocol=@proto)AS protocols,
            (SELECT COUNT(*) FROM [dbo].[EventGroup] WHERE PK_EventGroup=@eg) AS eventGroups,
            (SELECT COUNT(*) FROM [dbo].[Event]      WHERE PK_Event=@ev)     AS events,
            (SELECT COUNT(*) FROM [dbo].[Sample]     WHERE PK_Sample=@sa)    AS samples;
        `)).recordset[0];
    console.log('[smoke] DB counts after insert:',counts);

    // ── Batch 2: delete the whole chain. APPLY_ORDER will apply Site first
    // (which would FK-fail), but our code sorts deletes last per table so we
    // still need to send deletes in dependency-reverse order across tables.
    // Simplest: send them in reverse APPLY_ORDER manually — the loop respects
    // table ordering, so we just need each table's delete to come AFTER any
    // FK-dependent table in the same batch. We'll do it as a pre-sorted manual
    // sequence by calling applyPending once per table from leaf to root.

    console.log('\n[smoke] === delete batch (leaf → root, table at a time) ===');
    const deleteOrder=[
        ['Sample',samplePk],
        ['Event',eventPk],
        ['EventGroup',eventGroupPk],
        ['Protocol',protocolPk],
        ['Site',sitePk]
    ];
    const pkColumn={Sample: 'PK_Sample',Event: 'PK_Event',EventGroup: 'PK_EventGroup',Protocol: 'PK_Protocol',Site: 'PK_Site'};

    for(const [table,pk] of deleteOrder) {
        const pid=randomUUID();
        await queueRow(pool,pid,databaseGuid,table,3,{[pkColumn[table]]: pk});
        const r=await applyPending(pool,pid,{oid: 'smoke-chain'});
        console.log(`[smoke] delete ${table}:`,r.perTable[table]||r);
        await pool.request()
            .input('pid',sql.UniqueIdentifier,pid)
            .query(`
              DELETE FROM [dbo].[SyncCacheLog] WHERE ProcessId=@pid;
              DELETE FROM [dbo].[SyncCache]    WHERE ProcessId=@pid;
            `);
    }

    // Final cleanup: insert-batch SyncCache + log rows.
    await pool.request()
        .input('pid',sql.UniqueIdentifier,insertProcess)
        .query(`
          DELETE FROM [dbo].[SyncCacheLog] WHERE ProcessId=@pid;
          DELETE FROM [dbo].[SyncCache]    WHERE ProcessId=@pid;
        `);

    // Confirm gone.
    const after=(await pool.request()
        .input('site',sql.UniqueIdentifier,sitePk)
        .input('proto',sql.UniqueIdentifier,protocolPk)
        .input('eg',sql.UniqueIdentifier,eventGroupPk)
        .input('ev',sql.UniqueIdentifier,eventPk)
        .input('sa',sql.UniqueIdentifier,samplePk)
        .query(`
          SELECT
            (SELECT COUNT(*) FROM [dbo].[Site]       WHERE PK_Site=@site)    AS sites,
            (SELECT COUNT(*) FROM [dbo].[Protocol]   WHERE PK_Protocol=@proto)AS protocols,
            (SELECT COUNT(*) FROM [dbo].[EventGroup] WHERE PK_EventGroup=@eg) AS eventGroups,
            (SELECT COUNT(*) FROM [dbo].[Event]      WHERE PK_Event=@ev)     AS events,
            (SELECT COUNT(*) FROM [dbo].[Sample]     WHERE PK_Sample=@sa)    AS samples;
        `)).recordset[0];
    console.log('[smoke] DB counts after delete (all should be 0):',after);

    await pool.close();
    console.log('[smoke] done');
}

main().catch(err => {
    console.error('[smoke] FAILED:',err);
    process.exit(1);
});
