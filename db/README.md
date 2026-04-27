# Database deployment

SQL scripts for this folder are kept out of source control (see `.gitignore`).
Operators with access run them in order against the configured Azure SQL
database using credentials supplied via environment variables — never
checked in.

```powershell
# values come from your local environment / secret store
sqlcmd -S $env:SQL_SERVER -d $env:SQL_DATABASE -U $env:SQL_USER -P $env:SQL_PASSWORD -i db\schema.sql
sqlcmd -S $env:SQL_SERVER -d $env:SQL_DATABASE -U $env:SQL_USER -P $env:SQL_PASSWORD -i db\cache-tables.sql
```

Both scripts are idempotent — re-running is a no-op once tables exist.
