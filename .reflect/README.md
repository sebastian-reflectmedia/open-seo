# .reflect

Reflect Media's deployment layer for this fork. **Everything Reflect owns lives
here or in `.github/workflows/reflect-*.yml`** — new paths only, so an upstream
merge can never conflict with it.

Upstream is [`every-app/open-seo`](https://github.com/every-app/open-seo) (MIT).
The private companion repo is `sebastian-reflectmedia/reflect-openseo`, which holds
the resource IDs, the runbooks and the cost log.

## The rule

**This fork is public.** Forks of public repositories always are, and that cannot
be changed. So Reflect's Cloudflare resource IDs — KV and OAuth KV namespaces, the
D1 database, the R2 bucket — **never go in git here.** They arrive as repo secrets
and get written into `wrangler.jsonc` at deploy time by `apply-resources.mjs`.

`wrangler.jsonc` is **never modified in git on this fork.** If you find a commit
that edits it, something has gone wrong.

## Files

| Path                  | What                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `apply-resources.mjs` | Writes the six Reflect values into `wrangler.jsonc`. Hard-fails rather than deploy an unverified config |
| `upstream.lock`       | The upstream release this fork is synced to. Bumped only by `reflect-upstream-watch`, never by hand     |

## Workflows

| Workflow                 | When                            | What                                                                                                       |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `reflect-upstream-watch` | nightly 04:00 PT, or manual     | New upstream release → merge the tag to a branch, bump the lock, open a PR                                 |
| `reflect-migration-gate` | PRs touching `drizzle/**/*.sql` | Blocks merge if a new migration DROPs a table or column, until someone adds the `migration-reviewed` label |
| `reflect-deploy`         | push to `main`, or manual       | Apply config, capture a D1 restore point, export, deploy, smoke test both ways                             |

Upstream's own `ci.yml` runs on the sync PR and gates the merge, which is why the
watch workflow pushes with a PAT rather than `GITHUB_TOKEN` — events raised by
`GITHUB_TOKEN` do not start new workflow runs.

## Deploying by hand

`apply-resources.mjs` must run **before** `pnpm run deploy`. That script is
`db:migrate:prod && build && wrangler deploy`, and the migrate step reads
`database_id` and `migrations_dir` out of the same config file. Skipping it
migrates upstream's D1, not ours.

```bash
export REFLECT_KV_ID=... REFLECT_OAUTH_KV_ID=... \
       REFLECT_D1_NAME=... REFLECT_D1_ID=... REFLECT_R2_BUCKET=...
node .reflect/apply-resources.mjs && pnpm run deploy
```

`node .reflect/apply-resources.mjs --check` verifies the file as it stands and
writes nothing. It reports failure on an untouched upstream config, which is the
whole point — use it to confirm what you are about to deploy.

## Required repo secrets

`reflect-deploy` needs: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`REFLECT_KV_ID`, `REFLECT_OAUTH_KV_ID`, `REFLECT_D1_NAME`, `REFLECT_D1_ID`,
`REFLECT_R2_BUCKET`, and optionally `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`
for the authenticated smoke test.

`reflect-upstream-watch` needs `REFLECT_SYNC_TOKEN`, a fine-grained PAT scoped to
this fork with contents and pull-requests write.

The Cloudflare token needs **D1 Edit**. The dashboard's "Edit Cloudflare Workers"
template does not include it, and a token without it fails about 30 seconds in
with an unhelpful message.

## Preview URLs stay off

`apply-resources.mjs` forces `preview_urls: false`. Our Access applications match
the production hostname exactly, with no wildcard, so a version preview URL is a
different — unprotected — hostname running the full app against production data.
One was found live and executing on 2026-07-29.

Do not enable previews, and do not use `wrangler versions upload`, until an Access
application covers the preview hostnames.
