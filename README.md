# ENTITY-1

A luxury automobile brokerage website with a private, single-administrator content workspace. Open **Exclusive → Log in**, then Administration. There is no public signup, account setup page, or separate access key.

The source repository is [iddi1408/entity-one](https://github.com/iddi1408/entity-one) and is public. Sites hosts the application; no live URL is recorded here until deployment is confirmed. Do not commit account credentials, environment secrets, runtime data, or private content exports.

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
- **Inventory / Wanted:** add, edit, duplicate, or remove listings; manage photographs, galleries, featured placement, and private notes. Inventory statuses are available, reserved, sold, and draft. Wanted statuses are active, fulfilled, and draft. Public visitors see available/reserved inventory and active wanted requests. Drafts, sold/fulfilled records, and `internalNotes` stay private. Galleries support up to 12 additional images.
- **Site content:** edit homepage copy and artwork, About content, HTTPS video links, social profiles, and contact details. Maintain 1–12 offices, 0–24 team members, and 0–24 partners. Image fields accept HTTPS URLs or local `/assets/` paths.
- **Media:** upload PNG, JPEG, or WebP images up to 8 MiB, choose listing photographs, and copy image paths for other content fields. Uploaded files live outside the public source directory; anonymous visitors can retrieve them only when referenced by published content. Uploading an image alone does not publish it.
- **Backups:** download or import content JSON, or restore a saved version. Each successful save retains the previous snapshot; the latest 20 snapshots are kept. Restoring creates a new revision and checks that the current revision has not changed.
- **Activity:** inspect recent content, login, and session events. Credentials and private note text are excluded from the audit log.
- **Access:** inspect sessions, replace the current session token, sign out other sessions, or log out. Replacing a token does not extend its original eight-hour deadline.

Save changes explicitly. Version checks prevent a stale editor from silently overwriting a newer save. The homepage’s Pause motion control and the operating system’s reduced-motion preference control ambient motion.

## Account recovery

There is no online password reset or additional administrator account. For the **local preview only**, stop the server and run `npm run admin:provision`, supplying bounded UTF-8 JSON containing the `username` and `password` fields through stdin. This replaces administrator record 1 and revokes local sessions. It does not change hosted D1 credentials. The script never prints passwords, salts, or hashes. Keep secret values out of arguments, shell history, source files, and screenshots.

Hosted account recovery requires a controlled operation against the hosted administrator record and session data. The initial bootstrap secrets cannot reset an existing account. Retain authorized hosting access separately from site administrator access.

## Preserve your data

Content exports use `format: "entity-one-content-v1"`, `exportedAt`, and `content` containing settings and listings. They include drafts and private notes, but no account credentials, password hashes, session tokens, or audit history. JSON records image paths; it does **not** contain image files.

Hosted D1 stores content, the administrator hash, sessions, audit history, and snapshots. R2 stores uploaded media and large bundled assets. Preserve both stores through hosting backup procedures; a content JSON export alone is not a complete backup.

For a complete local backup, **stop the server**, then copy the entire `.sites-runtime/` directory to protected storage. It contains `preview.sqlite` and `uploads/`, including media metadata. Restore that directory with the server stopped. Keep the project's `public/assets/` for bundled artwork. `.sites-runtime/`, local environment files, and generated build output are ignored by Git and must stay out of the public repository.

## Content and artwork

Initial stock, specifications, availability, and wanted mandates are illustrative. Replace them with verified records before sharing the site publicly. Replace the example email, EU/US/UAE phone numbers, social links, and fictional team names. RM Sotheby’s is an example, not a confirmed partnership; Aurum Collective and Monarch Automotive are placeholders. Brand marks identify marques and do not imply endorsement.

The right-facing white Aventador SVJ hero is a generative studio illustration, not documentary inventory photography. Its reference credit is **MrWalkr, Wikimedia Commons, CC BY-SA 4.0**; the reference was adapted with AI, and the adapted artwork retains that license. See [white-svj-source.json](white-svj-source.json), the [reference photograph](https://commons.wikimedia.org/wiki/File:Lamborghini_Aventador_LP770-4_SVJ_White.jpg), and [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Other generated vehicle cutouts are also illustrative.

Demo photographs and their Unsplash License credits are recorded in [car-photo-sources.json](car-photo-sources.json) and [image-quality-sources.json](image-quality-sources.json). The Ferrari source does not independently establish a specific trim. [brand-logo-sources.json](brand-logo-sources.json) and [mclaren-speedmark-source.json](mclaren-speedmark-source.json) record logo sources and treatments. Globe geometry uses public-domain Natural Earth data projected with D3; see [globe-sources.json](globe-sources.json). Regional photograph credits remain in [region-photo-sources.json](region-photo-sources.json). Fonts and visual assets are served locally.

## Security scope

Controls include a database-enforced single administrator, salted PBKDF2-SHA256 password hashes at 600,000 iterations, login limits, HttpOnly/SameSite cookies, same-origin and CSRF checks, bounded requests, validated media, explicit public-content allowlists, session revocation, a 30-minute inactivity timeout, and an eight-hour maximum session. HTTPS cookies use Secure; the local HTTP loopback cookie cannot. Uploaded draft media is available to authenticated administrators and becomes publicly retrievable only when referenced by published content.

These controls reduce risk; no application is guaranteed unhackable. There is no MFA or application-level database encryption. Protect hosting access, backups, deployment secrets, and the local computer; keep dependencies maintained and investigate unexpected activity. Deployment verification and ongoing operations remain necessary.
