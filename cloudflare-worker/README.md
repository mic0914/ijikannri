# Cloudflare Worker environments

Ver.16.7 uses named Wrangler environments so local development, staging, and production do not share a Worker, D1 database, public origin, or secrets.

| Target | Worker name | D1 name | `PUBLIC_ORIGIN` |
| --- | --- | --- | --- |
| local | `ijikannri-access-development` | local persistent D1 | `http://127.0.0.1:8787` |
| staging | `ijikannri-access-staging` | `ijikannri-access-staging` | `https://ijikannri-access-staging.mic0914.workers.dev` |
| production | `ijikannri-access` | `ijikannri-access-log` | `https://ijikannri-access.mic0914.workers.dev` |

`ADMIN_KEY` and `SIGNING_SECRET` are secrets and must be different for staging and production. They are not stored in this repository. Configure staging only with:

```sh
npx wrangler secret put ADMIN_KEY --env staging
npx wrangler secret put SIGNING_SECRET --env staging
```

Local secrets belong in the ignored `.dev.vars` file:

```dotenv
ADMIN_KEY="local-only-admin-key"
SIGNING_SECRET="local-only-signing-secret"
```

Safe development commands:

```sh
npm run migrate:local
npm run dev
npm run check
```

Creating and deploying staging is explicit. The first staging deploy provisions the staging D1 binding and writes its ID into the staging configuration; then apply the migrations:

```sh
npm run deploy:staging
npm run migrate:staging
```

Wrangler automatically provisions the staging D1 binding when it is first deployed because its database ID is intentionally absent. Production has an invalid placeholder ID as a deployment guard. Replace that placeholder with the existing production D1 ID only after the release is explicitly approved; do not run a production deploy or production migration before then.
