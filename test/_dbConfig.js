// Shared mssql connection config for the smoke tests.
//
// Reads from environment variables ONLY — never hardcode secrets here.
// Set them once per shell session, e.g. (PowerShell):
//
//   $env:SQL_SERVER   = '<your-sql-server>.database.windows.net'
//   $env:SQL_DATABASE = '<your-database>'
//   $env:SQL_USER     = '<your-sql-user>'
//   $env:SQL_PASSWORD = '<your password>'
//
// Or drop a `test/.env.local` file (gitignored) and load it however you like.

function required(name) {
    const v=process.env[name];
    if(!v) {
        console.error(`[dbConfig] Missing required env var: ${name}`);
        console.error('[dbConfig] Set SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD before running smoke tests.');
        process.exit(1);
    }
    return v;
}

module.exports={
    server: required('SQL_SERVER'),
    database: required('SQL_DATABASE'),
    user: required('SQL_USER'),
    password: required('SQL_PASSWORD'),
    options: {encrypt: true,trustServerCertificate: false},
    pool: {max: 4,min: 0,idleTimeoutMillis: 30_000}
};
