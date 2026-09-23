---
name: verify
description: Build, launch, and drive the Split Bill Next.js + Postgres app locally to verify a change end-to-end.
---

# Verifying splitbill-js locally

Postgres 16 (`/usr/lib/postgresql/16/bin`) + `next dev` + Playwright on the pre-installed Chromium.

## 1. Postgres (must not run as root; short socket dir)

```bash
useradd -m postgres 2>/dev/null; export PGDATA=/tmp/pg-sb
mkdir -p $PGDATA && chown postgres $PGDATA
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U sb --auth=trust -E UTF8 >/dev/null && /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 55433 -k /tmp' -l $PGDATA/log start"
psql -h 127.0.0.1 -p 55433 -U sb -d postgres -c "CREATE DATABASE splitbill" -c "CREATE DATABASE splitbill_test"
DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill?sslmode=disable DB_DRIVER=pg npx tsx scripts/migrate.ts
```

## 2. App

`.env.local` (gitignored):

```
DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill?sslmode=disable
DB_DRIVER=pg
SETUP_SECRET=local-verify-secret-0123456789abcdef
```

`npm ci`, then `npx next dev -p 3222`. Without RESEND_API_KEY the email code is printed in the dev log.

## 3. Tests

```bash
npm test
TEST_DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill_test?sslmode=disable npm test
DATABASE_URL=postgresql://sb@127.0.0.1:55433/splitbill_test?sslmode=disable DB_DRIVER=pg npx tsx scripts/integrity_harness.ts
```

## 4. Playwright

- Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- `npm install playwright` in a scratch dir and run the script from there.
- Register at `/register` (`#reg-name`, `#reg-username`, `#reg-email`, `#reg-password`, `#register-btn`), land on `/app`.
- Google Fonts fail TLS in the sandbox; ignore `ERR_CERT_AUTHORITY_INVALID`.
- Check 400px and desktop widths.
