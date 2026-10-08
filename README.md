# ENTITY-1

A luxury automobile brokerage website with a private staff workspace. Open **Exclusive → Log in**, then Administration. The existing owner account controls access; public signup and separate access keys are disabled.

The public website is [ENTITY-1](https://entity-one-atelier.apexfngg.chatgpt.site/). The source repository is [iddi1408/entity-one](https://github.com/iddi1408/entity-one) and is public. Sites hosts the application. Do not commit account credentials, environment secrets, runtime data, or private content exports.

## Staff access and logs

In **Access**, the owner can create a staff username, choose an Administrator, Manager, Editor or Viewer preset, and adjust individual permissions. Write permissions include their corresponding read permission. Backup access includes the content access necessary to view or restore a full snapshot. Staff cannot grant permissions they do not have, modify their own access, or modify the owner. Only the owner can manage privileged staff accounts.

Creation and password resets generate a cryptographically random temporary password, displayed once to the operator. Deliver it privately to its recipient. It expires after seven days. The recipient must replace it at first login with a 12–128-character password before accessing administration. Only salted password hashes are stored. Disabling a staff account, changing its access or resetting its password revokes that account's sessions. Password changes revoke all prior sessions and issue a new session.

The **Logs** tab records actor, action, time, affected records and changed field names, with actor/action/date filters and pagination. Historical events without an actor retain a legacy label. Passwords, tokens and private listing-note values are excluded. Accounts with `logs.read` can view logs; `access.manage` is also required to retry failed Discord delivery.

Configure the Discord webhook only as the secret runtime variable **`DISCORD_AUDIT_WEBHOOK_URL`** in Sites. Never put the URL in content, browser code, Git, screenshots or public documentation. Newly recorded audit events enter a persistent D1 delivery queue and produce formatted Discord embeds with mentions disabled. Delivery is attempted after API requests, with bounded batches, rate-limit delays, retries and visible failure status. Pending retries resume on later API traffic or an explicit retry from Logs. Delivery is at least once: a lost acknowledgement can cause a duplicate notification with the same event ID. Local preview has no Discord secret by default.

## Website analytics

**Analytics** in the admin sidebar provides an overview, audience/source reports, and car/click reports, with date presets, optional country/device filters, daily trends and CSV export. The dashboard distinguishes incoming referrers from outgoing social links, explains each metric, and shows when data was last recorded and refreshed. Grant staff the **View website analytics** permission under Access & security; the owner always has access. New Administrator and Manager role presets include it. Existing staff permission selections remain unchanged until the owner edits them.

The first-party collector records public page views, car openings, region and brand selections, enquiry-link clicks and other named interactions. Countries describe the visitor's approximate edge-derived country, while region interest describes the location cards they chose. An enquiry is a link click, not a submitted enquiry or completed sale. Device and browser categories come from request headers; they are estimates. A visit is one page load/tab lifetime, not a unique person; reloading starts another visit. SPA navigation continues the same visit. Chart dates use UTC.

Incoming sources are literal hostnames reported by `document.referrer`, not verified Instagram/Meta or other platform analytics. Missing referrers remain **Not shared / direct**; there is no UTM attribution or external platform integration. Each visit is attributed to its first recorded page-view source within the selected period. Source coverage reports how many visits supplied a hostname, not a confidence score. Outgoing social events require an enabled HTTPS link to the expected platform; placeholders are ignored. Historical `social_*` icon events are kept separately as legacy data because they may include placeholder clicks. Partner placeholders and disabled controls are also ignored. Analytics is browser-reported, so blockers can cause missing activity and automated requests may still pass the filters.

Percentage comparisons are available only for completed UTC periods with a full previous period of collection; today and partial collection days do not produce misleading growth percentages. Collection start and available history are shown rather than treating pre-collection days as measured traffic. Historical event records are preserved, not rewritten to imply improved precision. Synthetic QA events are kept in a disposable local database and never deployed.

Measurement starts when the feature is published; previous traffic is unavailable. Reports cover the latest 90 days. Old events and short-lived rate-limit hashes are purged on subsequent collection requests. Analytics is separate from staff audit logs and is never sent to Discord. There are no tracking cookies or persistent browser identifiers. No raw IP, full user-agent, referrer path/query, form contents, credentials or contact-link addresses enter event records. Signed-in staff, recognised bots, Do Not Track and Global Privacy Control requests are excluded. Sessions that cannot be checked fail closed. Reports may therefore undercount traffic, and browser privacy tools can block collection.

`POST /api/analytics/events` accepts a bounded batch of allowlisted public events, checks same-origin JSON, validates public car IDs and known locations/marques, rate-limits requests, and deduplicates event UUIDs. `GET /api/analytics` requires a completed staff login and `analytics.read`. The public footer links to the factual analytics notice. Analytics is included in database backups, not content JSON exports.

## Architecture

- `public/` contains the HTML, CSS, browser ES modules, bundled artwork, and initial public content. The admin editor calls the same-origin `/api` endpoints.
- `worker/application.js` implements content, authentication, sessions, audit history, backups, and revision checks. `worker/media.js` and `worker/site-assets.js` serve uploaded media and bundled assets.
- Hosted persistence uses the D1 binding **`DB`** and R2 binding **`BUCKET`**, declared in `.openai/hosting.json`. SQL migrations live in `drizzle/`; the schema is defined in `db/schema.ts`.
- `scripts/build.mjs` bundles the Worker into `dist/server/index.js`, copies hosting configuration and migrations, and creates `.sites-runtime/deploy-assets.json`. Files over 32 KiB under `/assets/` are externalized to immutable SHA-256 R2 keys, preserving their original quality; smaller files are embedded in the bundle.
- Local development uses the same API with SQLite and filesystem media in `.sites-runtime/`. The preview session exposes `localOnly: true`; admin storage labels reflect whether the session is local or hosted.

## Run locally

Use Node.js 22.16 or newer. From this directory:

```powershell
npm install
npm run dev
```

Open **http://127.0.0.1:4174**. On Windows, `START-LOCAL.cmd` also starts the server. Keep its terminal open; press Ctrl+C to stop it. The preview listens on loopback only. Existing local content and administrator access persist across restarts.

Local startup applies the SQL migrations in `drizzle/`. Run `npm run db:generate` only when intentionally changing the schema; review generated migrations before using them.

## Build and test

```powershell
npm run build
npm run validate
npm test
npm run test:preview
npm run test:hosting
npm run test:staff
npm run test:analytics
```

These cover artifact structure, API authorization, content publication filtering, revision conflicts, backups, local media, password compatibility, administrator bootstrap, hosted media, and bundled R2 assets. Run them before deployment. Passing tests does not establish that a deployment has succeeded.

## Publish with Sites

Use the Sites source workflow and build helper for the existing project, then the native Sites deployment tools to publish the validated `dist/` artifact. `npm run build` prepares files only; it does not publish. Preserve the existing project ID, D1 database, R2 bucket, and intended audience. Record the live URL only after Sites reports successful deployment.

For the first hosted administrator, set temporary server secrets named **`ADMIN_INITIAL_USERNAME`** and **`ADMIN_INITIAL_PASSWORD`** through the hosting secret mechanism. They create administrator record 1 only when it is absent and a login matches both configured values; they never overwrite an existing administrator. After the first verified deployment and successful administrator login, remove both bootstrap secrets and redeploy. There is no public registration or bootstrap form.

`scripts/deploy-content.mjs` takes one JSON object through hidden stdin. Its fields are `url`, `username`, `password`, optional `bypassBearer` for a protected Sites audience, and `mode` (`migrate` or `verify`). Run it with Node's `--experimental-sqlite` flag. Supply the confirmed HTTPS site URL and credentials privately; never put their values in command arguments, source, logs, or documentation.

- **`migrate`** uploads bundled R2 assets, the current local content, and its referenced local uploads. It does not migrate local administrator records or sessions. Review the content before replacing hosted content.
- **`verify`** checks the hosted content and access controls without repeating content migration.

After migration, verify public pages, full-resolution media, administrator login, editing, and logout at the confirmed hosted URL. Keep the generated asset manifest with its matching build until asset migration has completed.

## Manage the site

- **Overview:** collection totals, current version, recent activity, and details still needing attention.
- **Analytics:** traffic trends, visitor countries/devices/referrers, automobile openings, enquiry clicks and location/marque interest. Use date and audience filters to compare the activity that matters to you.
- **Inventory / Wanted:** add, edit, duplicate, or remove listings; manage photographs, galleries, featured placement, and private notes. Inventory statuses are available, reserved, sold, and draft. Wanted statuses are active, fulfilled, and draft. Public visitors see available/reserved inventory and active wanted requests. Drafts, sold/fulfilled records, and `internalNotes` stay private. Galleries support up to 12 additional images.
- **Site content:** edit homepage copy and artwork, About content, HTTPS video links, social profiles, and contact details. Maintain 1–12 offices, 0–24 team members, and 0–24 partners. Image fields accept HTTPS URLs or local `/assets/` paths.
- **Media:** upload PNG, JPEG, or WebP images up to 8 MiB, choose listing photographs, and copy image paths for other content fields. Uploaded files live outside the public source directory; anonymous visitors can retrieve them only when referenced by published content. Uploading an image alone does not publish it.
- **Backups:** download or import content JSON, or restore a saved version. Each successful save retains the previous snapshot; the latest 20 snapshots are kept. Restoring creates a new revision and checks that the current revision has not changed.
- **Logs:** inspect who changed content or access and when, with Discord delivery status. Credentials and private note text are excluded from the audit log.
- **Access:** inspect sessions, replace the current session token, sign out other sessions, or log out. Replacing a token does not extend its original eight-hour deadline.

Save changes explicitly. Version checks prevent a stale editor from silently overwriting a newer save. The homepage’s Pause motion control and the operating system’s reduced-motion preference control ambient motion.

## Account recovery

Staff passwords can be reset from Access by an authorized account manager. The owner remains protected from staff-management changes. For **local owner recovery only**, stop the server and run `npm run admin:provision`, supplying bounded UTF-8 JSON containing the `username` and `password` fields through stdin. This replaces administrator record 1 and revokes local sessions. It does not change hosted D1 credentials. The script never prints passwords, salts, or hashes. Keep secret values out of arguments, shell history, source files, and screenshots.

Hosted account recovery requires a controlled operation against the hosted administrator record and session data. The initial bootstrap secrets cannot reset an existing account. Retain authorized hosting access separately from site administrator access.

## Preserve your data

Content exports use `format: "entity-one-content-v1"`, `exportedAt`, and `content` containing settings and listings. They include drafts and private notes, but no account credentials, password hashes, session tokens, or audit history. JSON records image paths; it does **not** contain image files.

Hosted D1 stores content, the administrator hash, sessions, audit history, and snapshots. R2 stores uploaded media and large bundled assets. Preserve both stores through hosting backup procedures; a content JSON export alone is not a complete backup.

For a complete local backup, **stop the server**, then copy the entire `.sites-runtime/` directory to protected storage. It contains `preview.sqlite` and `uploads/`, including media metadata. Restore that directory with the server stopped. Keep the project's `public/assets/` for bundled artwork. `.sites-runtime/`, local environment files, and generated build output are ignored by Git and must stay out of the public repository.

## Content and artwork

Initial stock, specifications, availability, and wanted mandates are illustrative; each record needs independent verification. Company copy, sales email, team and partner names were supplied by the owner on 8 October 2026. Office locations and phones remain undecided and unpublished; listed network cities are not office addresses. Social links and new partner links can be added through Site content. Brand marks identify marques and do not imply endorsement.

The right-facing white Aventador SVJ hero is a generative studio illustration, not documentary inventory photography. Its reference credit is **MrWalkr, Wikimedia Commons, CC BY-SA 4.0**; the reference was adapted with AI, and the adapted artwork retains that license. See [white-svj-source.json](white-svj-source.json), the [reference photograph](https://commons.wikimedia.org/wiki/File:Lamborghini_Aventador_LP770-4_SVJ_White.jpg), and [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Other generated vehicle cutouts are also illustrative.

Demo photographs and their Unsplash License credits are recorded in [car-photo-sources.json](car-photo-sources.json) and [image-quality-sources.json](image-quality-sources.json). The Ferrari source does not independently establish a specific trim. [brand-logo-sources.json](brand-logo-sources.json) and [mclaren-speedmark-source.json](mclaren-speedmark-source.json) record logo sources and treatments. Globe geometry uses public-domain Natural Earth data projected with D3; see [globe-sources.json](globe-sources.json). Regional photograph credits remain in [region-photo-sources.json](region-photo-sources.json). Fonts and visual assets are served locally.

## AI concierge

The public chat uses Claude Haiku 4.5 through the Worker. Set `ANTHROPIC_API_KEY` as a secret in Sites environment variables, then deploy to apply it. No key is included in browser assets. The local preview has chat disabled unless the secret is explicitly supplied to its server environment.

Replies use at most 220 output tokens, five recent messages (3,000 characters combined), and a bounded selection of public listings. No automatic retries or background model calls run. Defaults allow 6 requests per minute and 30 per UTC day per IP, with a global ceiling of 100 per UTC day. `CHAT_PER_MINUTE_LIMIT`, `CHAT_PER_IP_DAILY_LIMIT`, and `CHAT_DAILY_LIMIT` can lower these budgets; failed provider attempts consume limits too. Limits reset on the next period and are shared by visitors behind the same IP.

The site does not persist transcripts or send them to Discord. Claude receives submitted messages and public listing context; its provider policies apply. Responses are AI guidance and the team must confirm details. Use `npm run test:chat` for mocked checks without spending API tokens.

## Security controls

Controls include a protected owner account, server-enforced staff permissions, salted PBKDF2-SHA256 password hashes at 600,000 iterations, login limits, HttpOnly/SameSite cookies, same-origin and CSRF checks, bounded requests, validated media, explicit public-content allowlists, session revocation, a 30-minute inactivity timeout, and an eight-hour maximum session. HTTPS cookies use Secure; the local HTTP loopback cookie cannot. Uploaded draft media requires media permission and becomes publicly retrievable only when referenced by published content.

These controls reduce risk; no application is guaranteed unhackable. There is no MFA or application-level database encryption. Protect hosting access, backups, deployment secrets, and the local computer; keep dependencies maintained and investigate unexpected activity. Deployment verification and ongoing operations remain necessary.
