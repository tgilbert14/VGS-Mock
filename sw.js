// EcoPlot Field Collector — Service Worker
// Bump CACHE_VERSION whenever the HTML build revision changes.
const CACHE_VERSION='2026.04.21.49';
const CACHE=`ecoplot-${CACHE_VERSION}`;
const PRECACHE=[
    './ecoplot-field-collector.html',
    './manifest.json',
    './vendor/msal-browser.min.js'
];

// Install: pre-cache the app shell
self.addEventListener('install',e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

// Activate: delete any old cache versions
self.addEventListener('activate',e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k!==CACHE).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: serve from cache first (instant offline load),
// then update the cache in the background for next time.
self.addEventListener('fetch',e => {
    if(e.request.method!=='GET') return;

    e.respondWith(
        caches.open(CACHE).then(cache =>
            cache.match(e.request).then(cached => {
                const networkFetch=fetch(e.request).then(res => {
                    if(res&&res.ok) cache.put(e.request,res.clone());
                    return res;
                }).catch(() => null);
                // Return cached immediately if available; otherwise wait for network
                return cached||networkFetch;
            })
        )
    );
});
