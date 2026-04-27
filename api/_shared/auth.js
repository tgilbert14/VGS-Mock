// MSAL CIAM bearer-token verification + admin lookup.
// Extracted verbatim from index.js so all new endpoints share one auth path.

const {createRemoteJWKSet,jwtVerify}=require('jose');
const sql=require('mssql');

const AUTH_TENANT_ID=process.env.AUTH_TENANT_ID||'48daa81b-c1eb-4526-9ea1-66b60398179a';
const AUTH_CLIENT_ID=process.env.AUTH_CLIENT_ID||'025d2544-3267-47a5-a97d-261ae4e741fd';
const AUTH_AUTHORITY_HOST=process.env.AUTH_AUTHORITY_HOST||'ecoplot.ciamlogin.com';
const REQUIRE_USER_APPROVAL=['1','true','yes']
    .includes(String(process.env.REQUIRE_USER_APPROVAL||'').toLowerCase());

const JWKS=createRemoteJWKSet(
    new URL(`https://${AUTH_AUTHORITY_HOST}/${AUTH_TENANT_ID}/discovery/v2.0/keys`)
);
const VALID_AUDIENCES=[AUTH_CLIENT_ID,`api://${AUTH_CLIENT_ID}`];

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
            return {
                ok: false,status: 401,error: 'Unexpected tenant',
                detail: `Token tid ${payload.tid||'missing'} did not match expected tenant.`
            };
        }

        const issuer=String(payload.iss||'');
        let issuerMatchesAuthority=false;
        try {
            const u=new URL(issuer);
            const host=u.hostname.toLowerCase();
            const path=u.pathname.toLowerCase();
            const tenantSeg=`/${AUTH_TENANT_ID.toLowerCase()}/`;
            const isCiamHost=host===AUTH_AUTHORITY_HOST.toLowerCase()||host.endsWith('.ciamlogin.com');
            const isMsHost=host==='login.microsoftonline.com'||host==='sts.windows.net';
            issuerMatchesAuthority=(isCiamHost||isMsHost)&&path.includes(tenantSeg);
        } catch { /* ignore */}
        if(!issuerMatchesAuthority) {
            return {
                ok: false,status: 401,error: 'Unexpected issuer',
                detail: `Unexpected token issuer: ${issuer||'missing'}`
            };
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

// Returns { ok:true, user } or a ready-to-return jsonResponse-style failure object.
async function requireAuth(request,opts={}) {
    // ── DEV BYPASS ───────────────────────────────────────────────────────────
    // Set AUTH_DEV_BYPASS=1 in local.settings.json to skip token verification.
    // Returns a synthetic user. NEVER set this in production.
    if(['1','true','yes'].includes(String(process.env.AUTH_DEV_BYPASS||'').toLowerCase())) {
        const devOid=process.env.AUTH_DEV_OID||'00000000-0000-0000-0000-000000000dev';
        return {
            ok: true,
            user: {oid: devOid,email: 'dev@local',displayName: 'DEV BYPASS'}
        };
    }
    const r=await verifyAccessToken(request);
    if(!r.ok) return {ok: false,response: {status: r.status,error: r.error,detail: r.detail||null}};
    return {ok: true,user: r.user};
}

async function isApprovedUser(db,userOid) {
    const result=await db.request()
        .input('user_oid',sql.NVarChar(100),userOid)
        .query(`SELECT TOP 1 is_approved FROM approved_users WHERE user_oid = @user_oid`);
    return !!result.recordset[0]?.is_approved;
}

module.exports={
    verifyAccessToken,
    requireAuth,
    isApprovedUser,
    REQUIRE_USER_APPROVAL,
    AUTH_TENANT_ID,
    AUTH_CLIENT_ID
};
