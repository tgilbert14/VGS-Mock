/* eslint-env browser */
/* global crypto */
//
// cloudClient.js — frontend wrapper for the new VGS sync API.
//
// Exposes window.cloudClient with one entry per server endpoint plus a
// `runFullSync` helper that walks the device → server contract end-to-end:
//
//   1. POST /api/syncexchange      → register device, learn server SyncKeys
//   2. POST /api/cache/{table}     → upload pending rows per table
//   3. POST /api/saveCache         → server applies rows in FK order
//   4. GET  /api/viewsavelog/{pid} → fetch per-row outcomes for the user
//
// The caller supplies a getter for the bearer token (so we don't reach into
// MSAL state ourselves) and a baseUrl. Nothing here touches IndexedDB or the
// existing observations flow — that wiring lives in the HTML and will be
// replaced once the new endpoints are deployed.
//
// All payload `record` objects must already contain GUID primary keys and
// match the column names in api/_shared/tableSpecs.js (PK_Site, FK_Event, ...).

(function(global) {
    'use strict';

    const LOCAL_DATABASE_KEY='vgs.localDatabaseGuid';

    function mintGuid() {
        if(global.crypto&&typeof global.crypto.randomUUID==='function') {
            return global.crypto.randomUUID();
        }
        // RFC4122 v4 fallback for older browsers.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c) {
            const r=Math.random()*16|0;
            const v=c==='x'? r:(r&0x3|0x8);
            return v.toString(16);
        });
    }

    function getOrCreateLocalDatabaseId() {
        let id=global.localStorage&&global.localStorage.getItem(LOCAL_DATABASE_KEY);
        if(!id) {
            id=mintGuid();
            try {global.localStorage.setItem(LOCAL_DATABASE_KEY,id);} catch { /* private mode */}
        }
        return id;
    }

    function buildHeaders(token,functionsKey) {
        const h={'Content-Type': 'application/json'};
        if(token) h.Authorization=`Bearer ${token}`;
        if(functionsKey) h['x-functions-key']=functionsKey;
        return h;
    }

    function joinUrl(baseUrl,path) {
        const trimmed=String(baseUrl||'').replace(/\/+$/,'');
        return `${trimmed}/${path.replace(/^\/+/,'')}`;
    }

    async function postJson(url,body,headers) {
        const res=await fetch(url,{
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const text=await res.text();
        let data=null;
        try {data=text? JSON.parse(text):null;} catch { /* leave null */}
        if(!res.ok) {
            const err=new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
            err.status=res.status;
            err.body=data||text;
            throw err;
        }
        return data;
    }

    async function getJson(url,headers) {
        const res=await fetch(url,{method: 'GET',headers});
        const text=await res.text();
        let data=null;
        try {data=text? JSON.parse(text):null;} catch { /* leave null */}
        if(!res.ok) {
            const err=new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
            err.status=res.status;
            err.body=data||text;
            throw err;
        }
        return data;
    }

    function makeClient(opts) {
        const baseUrl=opts&&opts.baseUrl;
        const getToken=(opts&&opts.getToken)||(async () => null);
        const getFunctionsKey=(opts&&opts.getFunctionsKey)||(() => null);
        if(!baseUrl) throw new Error('cloudClient: baseUrl required');

        async function headers() {
            const [token,key]=await Promise.all([
                Promise.resolve().then(getToken),
                Promise.resolve().then(getFunctionsKey)
            ]);
            return buildHeaders(token,key);
        }

        async function syncExchange(localDatabase) {
            return postJson(
                joinUrl(baseUrl,'syncexchange'),
                {localDatabase},
                await headers()
            );
        }

        async function getLastSyncKey(localDatabase,tables) {
            return postJson(
                joinUrl(baseUrl,'getlastsynckey'),
                {localDatabase,tables: tables||null},
                await headers()
            );
        }

        // rows: [{op:1|2|3|4, pk:'<guid>', record:{...}, deviceSyncState:0|1|2}]
        async function pushTable(table,localDatabase,rows,processId) {
            return postJson(
                joinUrl(baseUrl,`cache/${encodeURIComponent(table)}`),
                {processId: processId||undefined,localDatabase,rows},
                await headers()
            );
        }

        async function saveCache(processId) {
            return postJson(
                joinUrl(baseUrl,'saveCache'),
                {processId},
                await headers()
            );
        }

        async function viewSaveLog(processId) {
            return getJson(
                joinUrl(baseUrl,`viewsavelog/${encodeURIComponent(processId)}`),
                await headers()
            );
        }

        // rowsByTable: {Site:[...], Protocol:[...], Event:[...], Sample:[...]}
        // Order of object keys does NOT matter — server applies in APPLY_ORDER.
        async function runFullSync(rowsByTable,options) {
            const localDatabase=(options&&options.localDatabase)||getOrCreateLocalDatabaseId();
            const exchange=await syncExchange(localDatabase);

            let processId=null;
            const pushSummary={};
            for(const table of Object.keys(rowsByTable)) {
                const rows=rowsByTable[table];
                if(!rows||!rows.length) continue;
                const r=await pushTable(table,localDatabase,rows,processId);
                processId=r.processId;
                pushSummary[table]=r.inserted;
            }

            if(!processId) {
                return {
                    localDatabase,
                    serverSyncKeys: exchange&&exchange.syncKeys,
                    skipped: true,
                    message: 'Nothing to push'
                };
            }

            const saveResult=await saveCache(processId);
            const log=await viewSaveLog(processId);

            return {
                localDatabase,
                processId,
                serverSyncKeys: exchange&&exchange.syncKeys,
                pushSummary,
                applied: saveResult.applied,
                skipped: saveResult.skipped,
                failed: saveResult.failed,
                perTable: saveResult.perTable,
                log: log&&log.entries
            };
        }

        return {
            baseUrl,
            mintGuid,
            getOrCreateLocalDatabaseId,
            syncExchange,
            getLastSyncKey,
            pushTable,
            saveCache,
            viewSaveLog,
            runFullSync
        };
    }

    global.cloudClient={
        create: makeClient,
        mintGuid,
        getOrCreateLocalDatabaseId
    };
})(typeof window!=='undefined'? window:globalThis);
