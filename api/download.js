// Download endpoints — mirrors the AWS WebApi paged-download contract.
//
// POST /api/SetSeedCaching     body: {
//     localDatabase: <guid>,
//     siteClassIds:  <guid>[],          // folder roots the user picked
//     dateFrom?:     ISO datetime,      // Protocol.Date filter (inclusive)
//     dateTo?:       ISO datetime,
//     includeReferenceData?: boolean    // default true: pull all Species/TypeList/etc.
//   }
//   Snapshots the PK lists the device will pull into [dbo].[SyncSeed] under a
//   freshly-minted SeedId (UUID). Returns counts per table so the device knows
//   how many pages to request.
//
// POST /api/DeleteSeedCaching  body: { seedId: <guid> }
//   Clears the seed snapshot once the device finishes pulling.
//
// POST /api/download/{table}/{skip}/{take}   body: { seedId: <guid> }
//   Returns rows from [dbo].[{table}] that are part of the snapshot,
//   ordered by SyncSeed.SortKey, paged.

const {randomUUID}=require('crypto');
const {app}=require('@azure/functions');
const {jsonResponse,preflight}=require('./_shared/cors');
const {requireAuth}=require('./_shared/auth');
const {getPool,sql}=require('./_shared/sql');

// Whitelist for the dynamic /download/{table}/... route. Prevents SQL
// injection via the route param.
const DOWNLOADABLE_TABLES=new Set([
    'Site','SiteClass','SiteClassLink','Locator','SitePhoto',
    'Protocol','EventGroup','Event','Sample','SampleDatum',
    'PhotoDoc','SpList','SpListLink','Species','TypeList','SubTypeList',
    'Contact','ContactLink','Inquiry','InquiryDatum','Report'
]);

// Legacy PK column for each downloadable table — used to join real rows
// against [SyncSeed].[RecordPK].
const TABLE_PK={
    Site: 'PK_Site',SiteClass: 'PK_SiteClass',SiteClassLink: 'PK_SiteClassLink',
    Locator: 'PK_Locator',SitePhoto: 'PK_Site',
    Protocol: 'PK_Protocol',EventGroup: 'PK_EventGroup',Event: 'PK_Event',
    Sample: 'PK_Sample',SampleDatum: 'PK_SampleDatum',PhotoDoc: 'PK_PhotoDoc',
    SpList: 'PK_SpList',SpListLink: 'PK_SpListLink',
    Species: 'PK_Species',TypeList: 'PK_Type',SubTypeList: 'PK_SubType',
    Contact: 'PK_Contact',ContactLink: 'PK_ContactLink',
    Inquiry: 'PK_Inquiry',InquiryDatum: 'PK_InquiryDatum',Report: 'PK_Report'
};

function isValidGuid(s) {
    return typeof s==='string'&&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

app.http('SetSeedCaching',{
    methods: ['POST','OPTIONS'],
    route: 'SetSeedCaching',
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
        const siteClassIds=(Array.isArray(body?.siteClassIds)? body.siteClassIds:[])
            .map(s => String(s||'').trim())
            .filter(isValidGuid);
        if(!siteClassIds.length) {
            return jsonResponse(400,{error: 'siteClassIds is required (at least one valid GUID)'});
        }
        const dateFrom=body?.dateFrom? new Date(body.dateFrom):null;
        const dateTo=body?.dateTo? new Date(body.dateTo):null;
        if(dateFrom&&isNaN(dateFrom.getTime())) return jsonResponse(400,{error: 'Invalid dateFrom'});
        if(dateTo&&isNaN(dateTo.getTime())) return jsonResponse(400,{error: 'Invalid dateTo'});
        const includeReferenceData=body?.includeReferenceData!==false;

        const seedId=randomUUID();

        // The seed walk runs as one SQL batch against the same session so that
        // local temp tables (#classes, #sites, ...) are visible to every step.
        const seedWalkSql=`
          SET NOCOUNT ON;
          DECLARE @ids TABLE (id UNIQUEIDENTIFIER PRIMARY KEY);
          INSERT INTO @ids (id)
          SELECT TRY_CAST(value AS UNIQUEIDENTIFIER)
          FROM OPENJSON(@siteClassIdsJson)
          WHERE TRY_CAST(value AS UNIQUEIDENTIFIER) IS NOT NULL;

          /* 1. Expand SiteClass tree from chosen roots via CK_ParentClass. */
          ;WITH ClassTree AS (
              SELECT PK_SiteClass FROM [dbo].[SiteClass] WHERE PK_SiteClass IN (SELECT id FROM @ids)
              UNION ALL
              SELECT c.PK_SiteClass
              FROM [dbo].[SiteClass] c
              INNER JOIN ClassTree p ON c.CK_ParentClass = p.PK_SiteClass
          )
          SELECT DISTINCT PK_SiteClass INTO #classes FROM ClassTree OPTION (MAXRECURSION 100);

          /* 2. SiteClassLink rows touching any of those classes; Sites linked through them. */
          SELECT scl.PK_SiteClassLink, scl.FK_Site, scl.FK_SiteClass
          INTO #sclinks
          FROM [dbo].[SiteClassLink] scl
          INNER JOIN #classes c ON scl.FK_SiteClass = c.PK_SiteClass;

          SELECT DISTINCT FK_Site AS PK_Site INTO #sites FROM #sclinks;

          /* 3. Events at any selected site OR class, optionally date-filtered via Protocol.Date. */
          SELECT e.PK_Event, e.FK_EventGroup
          INTO #events
          FROM [dbo].[Event] e
          LEFT JOIN [dbo].[EventGroup] eg ON eg.PK_EventGroup = e.FK_EventGroup
          LEFT JOIN [dbo].[Protocol]   p  ON p.PK_Protocol   = eg.FK_Protocol
          WHERE (e.FK_Site IN (SELECT PK_Site FROM #sites)
                 OR e.FK_SiteClass IN (SELECT PK_SiteClass FROM #classes))
            AND (@dateFrom IS NULL OR p.[Date] IS NULL OR p.[Date] >= @dateFrom)
            AND (@dateTo   IS NULL OR p.[Date] IS NULL OR p.[Date] <= @dateTo);

          /* 4. EventGroups + Protocols touched by selected events. */
          SELECT DISTINCT FK_EventGroup AS PK_EventGroup INTO #egroups FROM #events WHERE FK_EventGroup IS NOT NULL;
          SELECT DISTINCT eg.FK_Protocol AS PK_Protocol
          INTO #protocols
          FROM [dbo].[EventGroup] eg
          INNER JOIN #egroups g ON g.PK_EventGroup = eg.PK_EventGroup
          WHERE eg.FK_Protocol IS NOT NULL;

          /* 5. Samples + SampleDatum cascading from selected events. */
          SELECT s.PK_Sample INTO #samples
          FROM [dbo].[Sample] s INNER JOIN #events e ON s.FK_Event = e.PK_Event;

          SELECT sd.PK_SampleDatum, sd.FK_PhotoDoc INTO #sdata
          FROM [dbo].[SampleDatum] sd INNER JOIN #samples s ON sd.FK_Sample = s.PK_Sample;

          /* 6. PhotoDoc: any referenced by SampleDatum, plus all photos at selected sites. */
          SELECT DISTINCT pd.PK_PhotoDoc INTO #photos
          FROM [dbo].[PhotoDoc] pd
          WHERE pd.PK_PhotoDoc IN (SELECT FK_PhotoDoc FROM #sdata WHERE FK_PhotoDoc IS NOT NULL)
             OR pd.FK_Site     IN (SELECT PK_Site FROM #sites);

          /* 7. Locators tied to selected sites. */
          SELECT l.PK_Locator INTO #locators
          FROM [dbo].[Locator] l WHERE l.FK_Site IN (SELECT PK_Site FROM #sites);

          /* 8. Inquiry + InquiryDatum tied to selected events. */
          SELECT i.PK_Inquiry INTO #inquiries
          FROM [dbo].[Inquiry] i WHERE i.FK_Event IN (SELECT PK_Event FROM #events);

          SELECT idt.PK_InquiryDatum INTO #idata
          FROM [dbo].[InquiryDatum] idt INNER JOIN #inquiries i ON idt.FK_Inquiry = i.PK_Inquiry;

          /* 9. ContactLink + parent Contact rows. */
          SELECT cl.PK_ContactLink, cl.FK_Contact
          INTO #clinks
          FROM [dbo].[ContactLink] cl
          WHERE cl.FK_Site      IN (SELECT PK_Site      FROM #sites)
             OR cl.FK_SiteClass IN (SELECT PK_SiteClass FROM #classes)
             OR cl.FK_Protocol  IN (SELECT PK_Protocol  FROM #protocols);

          SELECT DISTINCT FK_Contact AS PK_Contact INTO #contacts FROM #clinks;

          /* 10. Insert seed rows for everything we collected. SortKey orders pages. */
          INSERT INTO [dbo].[SyncSeed] (SeedId, [Database], UserOid, TableName, RecordPK, SortKey)
          SELECT @seedId, @database, @userOid, 'SiteClass',     CONVERT(NVARCHAR(100), PK_SiteClass),     1 FROM #classes
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Site',          CONVERT(NVARCHAR(100), PK_Site),          2 FROM #sites
          UNION ALL
          SELECT @seedId, @database, @userOid, 'SiteClassLink', CONVERT(NVARCHAR(100), PK_SiteClassLink), 3 FROM #sclinks
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Locator',       CONVERT(NVARCHAR(100), PK_Locator),       4 FROM #locators
          UNION ALL
          SELECT @seedId, @database, @userOid, 'SitePhoto',     CONVERT(NVARCHAR(100), sp.PK_Site),       5
            FROM [dbo].[SitePhoto] sp INNER JOIN #sites s ON sp.PK_Site = s.PK_Site
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Protocol',      CONVERT(NVARCHAR(100), PK_Protocol),      6 FROM #protocols
          UNION ALL
          SELECT @seedId, @database, @userOid, 'EventGroup',    CONVERT(NVARCHAR(100), PK_EventGroup),    7 FROM #egroups
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Event',         CONVERT(NVARCHAR(100), PK_Event),         8 FROM #events
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Sample',        CONVERT(NVARCHAR(100), PK_Sample),        9 FROM #samples
          UNION ALL
          SELECT @seedId, @database, @userOid, 'SampleDatum',   CONVERT(NVARCHAR(100), PK_SampleDatum),  10 FROM #sdata
          UNION ALL
          SELECT @seedId, @database, @userOid, 'PhotoDoc',      CONVERT(NVARCHAR(100), PK_PhotoDoc),     11 FROM #photos
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Inquiry',       CONVERT(NVARCHAR(100), PK_Inquiry),      12 FROM #inquiries
          UNION ALL
          SELECT @seedId, @database, @userOid, 'InquiryDatum',  CONVERT(NVARCHAR(100), PK_InquiryDatum), 13 FROM #idata
          UNION ALL
          SELECT @seedId, @database, @userOid, 'Contact',       CONVERT(NVARCHAR(100), PK_Contact),      14 FROM #contacts
          UNION ALL
          SELECT @seedId, @database, @userOid, 'ContactLink',   CONVERT(NVARCHAR(100), PK_ContactLink),  15 FROM #clinks;

          /* 11. Reference data (entire tables) when requested. Small enough to ship in full. */
          IF @includeReferenceData = 1
          BEGIN
              INSERT INTO [dbo].[SyncSeed] (SeedId, [Database], UserOid, TableName, RecordPK, SortKey)
              SELECT @seedId, @database, @userOid, 'Species',     CONVERT(NVARCHAR(100), PK_Species),  20 FROM [dbo].[Species]
              UNION ALL
              SELECT @seedId, @database, @userOid, 'TypeList',    CONVERT(NVARCHAR(100), PK_Type),     21 FROM [dbo].[TypeList]
              UNION ALL
              SELECT @seedId, @database, @userOid, 'SubTypeList', CONVERT(NVARCHAR(100), PK_SubType),  22 FROM [dbo].[SubTypeList]
              UNION ALL
              SELECT @seedId, @database, @userOid, 'SpList',      CONVERT(NVARCHAR(100), PK_SpList),   23 FROM [dbo].[SpList]
              UNION ALL
              SELECT @seedId, @database, @userOid, 'SpListLink',  CONVERT(NVARCHAR(100), PK_SpListLink), 24 FROM [dbo].[SpListLink]
              UNION ALL
              SELECT @seedId, @database, @userOid, 'Report',      CONVERT(NVARCHAR(100), PK_Report),   25 FROM [dbo].[Report];
          END

          /* 12. Counts per table for the response. */
          SELECT TableName, COUNT(*) AS [Count]
          FROM [dbo].[SyncSeed]
          WHERE SeedId = @seedId
          GROUP BY TableName
          ORDER BY MIN(SortKey);
        `;

        try {
            const db=await getPool();
            const result=await db.request()
                .input('seedId',sql.UniqueIdentifier,seedId)
                .input('database',sql.UniqueIdentifier,localDatabase)
                .input('userOid',sql.NVarChar(100),auth.user.oid)
                .input('siteClassIdsJson',sql.NVarChar(sql.MAX),JSON.stringify(siteClassIds))
                .input('dateFrom',sql.DateTime2,dateFrom)
                .input('dateTo',sql.DateTime2,dateTo)
                .input('includeReferenceData',sql.Bit,includeReferenceData? 1:0)
                .query(seedWalkSql);

            const counts={};
            let total=0;
            for(const row of result.recordset||[]) {
                counts[row.TableName]=row.Count;
                total+=row.Count;
            }
            return jsonResponse(200,{
                success: true,
                seedId,
                localDatabase,
                totalRows: total,
                counts
            });
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});

app.http('DeleteSeedCaching',{
    methods: ['POST','OPTIONS'],
    route: 'DeleteSeedCaching',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        let body;
        try {body=await request.json();}
        catch {return jsonResponse(400,{error: 'Invalid JSON'});}

        const seedId=String(body?.seedId||'').trim();
        if(!isValidGuid(seedId)) {
            return jsonResponse(400,{error: 'Missing or invalid seedId (expected GUID)'});
        }

        try {
            const db=await getPool();
            const r=await db.request()
                .input('sid',sql.UniqueIdentifier,seedId)
                .query(`DELETE FROM [dbo].[SyncSeed] WHERE SeedId = @sid; SELECT @@ROWCOUNT AS deleted;`);
            return jsonResponse(200,{success: true,seedId,deleted: r.recordset[0]?.deleted??0});
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});

app.http('downloadPaged',{
    methods: ['POST','OPTIONS'],
    route: 'download/{table}/{skip:int}/{take:int}',
    authLevel: 'anonymous',
    handler: async (request) => {
        if((request.method||'').toUpperCase()==='OPTIONS') return preflight();

        const auth=await requireAuth(request);
        if(!auth.ok) return jsonResponse(auth.response.status,auth.response);

        const table=request.params.table;
        const skip=Math.max(0,Number(request.params.skip)||0);
        const take=Math.min(1000,Math.max(1,Number(request.params.take)||100));

        if(!DOWNLOADABLE_TABLES.has(table)) {
            return jsonResponse(400,{error: `Table not downloadable: ${table}`});
        }
        const pkCol=TABLE_PK[table];

        let body;
        try {body=await request.json();}
        catch {return jsonResponse(400,{error: 'Invalid JSON'});}

        const seedId=String(body?.seedId||'').trim();
        if(!isValidGuid(seedId)) {
            return jsonResponse(400,{error: 'Missing or invalid seedId (expected GUID)'});
        }

        try {
            const db=await getPool();
            // Join real table to seed snapshot, paged.
            const result=await db.request()
                .input('sid',sql.UniqueIdentifier,seedId)
                .input('tbl',sql.NVarChar(64),table)
                .input('skip',sql.Int,skip)
                .input('take',sql.Int,take)
                .query(`
          SELECT t.*
          FROM [dbo].[${table}] t
          INNER JOIN [dbo].[SyncSeed] s
                  ON s.TableName = @tbl
                 AND CONVERT(NVARCHAR(100), t.[${pkCol}]) = s.RecordPK
          WHERE s.SeedId = @sid
          ORDER BY s.SortKey, s.RecordPK
          OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
        `);
            return jsonResponse(200,{
                success: true,
                table,skip,take,
                count: result.recordset.length,
                rows: result.recordset
            });
        } catch(err) {
            return jsonResponse(500,{error: 'Database error',detail: err.message});
        }
    }
});
