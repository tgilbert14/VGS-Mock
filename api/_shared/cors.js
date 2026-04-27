// Shared CORS + JSON response helpers.
// Single source of truth for ALLOWED_ORIGIN; bumping origins only happens here.

const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'https://tgilbert14.github.io';

const CORS_HEADERS={
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonResponse(status,payload) {
    return {
        status,
        headers: {'Content-Type': 'application/json',...CORS_HEADERS},
        body: JSON.stringify(payload)
    };
}

function preflight() {
    return {status: 204,headers: CORS_HEADERS,body: ''};
}

module.exports={ALLOWED_ORIGIN,CORS_HEADERS,jsonResponse,preflight};
