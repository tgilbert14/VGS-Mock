// saveCache apply-loop. Extracted so test scripts can call it without
// triggering the @azure/functions app.http() side-effects in cache.js.

const {SPECS,APPLY_ORDER}=require('./tableSpecs');
const {sql}=require('./sql');

// Translate a spec type string ('NVarChar(100)', 'Int', 'NVarChar(MAX)', ...)
// into a live mssql sql-type instance for parameter binding.
function toSqlType(typeSpec) {
    const m=String(typeSpec).match(/^([A-Za-z]+)(?:\(([^)]+)\))?$/);
    if(!m) throw new Error(`Bad type spec: ${typeSpec}`);
    const base=m[1];
    const arg=m[2];
    switch(base) {
        case 'UniqueIdentifier': return sql.UniqueIdentifier;
        case 'Int': return sql.Int;
        case 'BigInt': return sql.BigInt;
        case 'Bit': return sql.Bit;
        case 'Float': return sql.Float;
        case 'DateTime': return sql.DateTime;
        case 'DateTime2': return sql.DateTime2;
        case 'NVarChar': {
            const len=arg==='MAX'? sql.MAX:Number(arg);
            return sql.NVarChar(len);
        }
        default: throw new Error(`Unsupported type spec: ${typeSpec}`);
    }
}

function coerceValue(col,raw) {
    if(raw===undefined||raw===null) return null;
    const base=String(col.t).split('(')[0];
    if(base==='UniqueIdentifier'||base.startsWith('NVarChar')) return String(raw);
    if(base==='Int'||base==='BigInt') return Number(raw);
    if(base==='Bit') return raw? 1:0;
    if(base==='Float') return Number(raw);
    if(base==='DateTime'||base==='DateTime2') return new Date(raw);
    return raw;
}

async function markCacheRow(db,pkSyncCache,status,error) {
    await db.request()
        .input('pk',sql.BigInt,pkSyncCache)
        .input('status',sql.NVarChar(20),status)
        .input('err',sql.NVarChar(4000),error)
        .query(`
          UPDATE [dbo].[SyncCache]
          SET [Status] = @status,
              [Error] = @err,
              [AppliedAt] = SYSUTCDATETIME()
          WHERE [PK_SyncCache] = @pk;
        `);
}

async function flushLog(db,processId,database,userOid,entries) {
    if(!entries.length) return;
    const json=JSON.stringify(entries);
    await db.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .input('database',sql.UniqueIdentifier,database)
        .input('user',sql.NVarChar(100),userOid)
        .input('json',sql.NVarChar(sql.MAX),json)
        .query(`
          INSERT INTO [dbo].[SyncCacheLog]
            (ProcessId, [Database], UserOid, [Level], TableName, Op, RecordPK, [Message])
          SELECT @pid, @database, @user,
                 j.[level], j.[table], j.[op], j.[pk], j.[message]
          FROM OPENJSON(@json) WITH (
            [level]   NVARCHAR(10)   '$.level',
            [table]   NVARCHAR(64)   '$.table',
            [op]      INT            '$.op',
            [pk]      NVARCHAR(100)  '$.pk',
            [message] NVARCHAR(4000) '$.message'
          ) j;
        `);
}

async function applyOneRow(db,row,nextSyncKey,log) {
    const spec=SPECS[row.TableName];
    if(!spec) {
        await markCacheRow(db,row.PK_SyncCache,'skipped',
            `No spec for table ${row.TableName} (admin tables not writable here)`);
        log.push({
            level: 'warn',table: row.TableName,op: row.Op,pk: null,
            message: 'No spec; row skipped'
        });
        return 'skipped';
    }

    let payload;
    try {payload=JSON.parse(row.PayloadJson||'{}');}
    catch(e) {
        await markCacheRow(db,row.PK_SyncCache,'failed',`Invalid PayloadJson: ${e.message}`);
        log.push({
            level: 'error',table: row.TableName,op: row.Op,pk: null,
            message: `Invalid PayloadJson: ${e.message}`
        });
        return 'failed';
    }

    const pkVal=payload[spec.pk];
    if(pkVal==null) {
        await markCacheRow(db,row.PK_SyncCache,'failed',`Payload missing PK column ${spec.pk}`);
        log.push({
            level: 'error',table: row.TableName,op: row.Op,pk: null,
            message: `Payload missing PK column ${spec.pk}`
        });
        return 'failed';
    }

    try {
        if(row.Op===4) {
            await markCacheRow(db,row.PK_SyncCache,'applied',null);
            log.push({
                level: 'info',table: row.TableName,op: 4,pk: String(pkVal),
                message: 'No-op (op=4)'
            });
            return 'applied';
        }

        if(row.Op===3) {
            const r=await db.request()
                .input('pk',toSqlType(spec.pkType),coerceValue({t: spec.pkType},pkVal))
                .query(`DELETE FROM [dbo].[${row.TableName}] WHERE [${spec.pk}] = @pk;
                        SELECT @@ROWCOUNT AS deleted;`);
            const deleted=r.recordset[0]?.deleted??0;
            if(deleted===0) {
                await markCacheRow(db,row.PK_SyncCache,'skipped','Delete: row not found');
                log.push({
                    level: 'warn',table: row.TableName,op: 3,pk: String(pkVal),
                    message: 'Delete: row not found'
                });
                return 'skipped';
            }
            await markCacheRow(db,row.PK_SyncCache,'applied',null);
            log.push({
                level: 'info',table: row.TableName,op: 3,pk: String(pkVal),
                message: 'Deleted'
            });
            return 'applied';
        }

        // Op 1 (insert) and Op 2 (update) both go through MERGE so the device
        // can be sloppy about which it sends. We log the intended op for audit.
        const cols=spec.columns;
        const setList=cols.filter(c => c.name!==spec.pk)
            .map(c => `[${c.name}] = s.[${c.name}]`).join(', ');
        const usingList=cols.map(c => `@${c.name} AS [${c.name}]`).join(', ');
        const insertCols=cols.map(c => `[${c.name}]`).join(', ');
        const insertVals=cols.map(c => `s.[${c.name}]`).join(', ');

        const mergeSql=`
          MERGE [dbo].[${row.TableName}] AS t
          USING (SELECT ${usingList}) AS s
          ON t.[${spec.pk}] = s.[${spec.pk}]
          WHEN MATCHED THEN UPDATE SET
            ${setList},
            [SyncKey] = @__syncKey,
            [SyncState] = 4
          WHEN NOT MATCHED THEN INSERT (${insertCols}, [SyncKey], [SyncState])
            VALUES (${insertVals}, @__syncKey, 4)
          OUTPUT $action AS Action;
        `;

        const req=db.request().input('__syncKey',sql.BigInt,nextSyncKey);
        for(const c of cols) {
            req.input(c.name,toSqlType(c.t),coerceValue(c,payload[c.name]));
        }
        const r=await req.query(mergeSql);
        const action=r.recordset[0]?.Action||'UNKNOWN';

        await markCacheRow(db,row.PK_SyncCache,'applied',null);
        log.push({
            level: 'info',table: row.TableName,op: row.Op,pk: String(pkVal),
            message: `Merged (${action})`
        });
        return 'applied';
    } catch(err) {
        await markCacheRow(db,row.PK_SyncCache,'failed',err.message);
        log.push({
            level: 'error',table: row.TableName,op: row.Op,pk: String(pkVal),
            message: err.message
        });
        return 'failed';
    }
}

async function applyPending(db,processId,user) {
    const counts={applied: 0,skipped: 0,failed: 0};
    const perTable={};
    const log=[];

    const pending=(await db.request()
        .input('pid',sql.UniqueIdentifier,processId)
        .query(`
          SELECT PK_SyncCache, [Database], TableName, Op, PayloadJson
          FROM [dbo].[SyncCache]
          WHERE ProcessId = @pid AND Status = 'pending'
        `)).recordset;

    if(!pending.length) {
        return {applied: 0,skipped: 0,failed: 0,perTable: {}};
    }

    const groups=new Map();
    for(const r of pending) {
        if(!groups.has(r.TableName)) groups.set(r.TableName,[]);
        groups.get(r.TableName).push(r);
    }

    const orderedTables=APPLY_ORDER.filter(t => groups.has(t))
        .concat([...groups.keys()].filter(t => !APPLY_ORDER.includes(t)));

    for(const t of orderedTables) {
        groups.get(t).sort((a,b) => (a.Op===3? 1:0)-(b.Op===3? 1:0));
    }

    const baseSyncKey=Date.now();
    let keyOffset=0;
    const databaseGuid=pending[0].Database;

    for(const t of orderedTables) {
        const rows=groups.get(t);
        perTable[t]={applied: 0,skipped: 0,failed: 0};
        for(const row of rows) {
            const status=await applyOneRow(db,row,baseSyncKey+keyOffset++,log);
            counts[status]++;
            perTable[t][status]++;
        }
    }

    await flushLog(db,processId,databaseGuid,user.oid,log);
    return {...counts,perTable};
}

module.exports={applyPending,toSqlType,coerceValue};
