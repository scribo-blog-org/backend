# Scribo backend

The HTTP API of the Scribo blog. Accounts, posts, comments, search, conversations, support tickets, admin data and backups. It owns every piece of persistent state in the system. It does not hold WebSocket connections: realtime events are published to Redis and delivered to browsers by the `socket` service.

Production: `https://scribo.pp.ua/api`. Staging: `https://scribo-stage.pp.ua/api`. The frontend and the socket service answer on the same hosts; how nginx splits them is described in the `infra` repository.

## Repositories

| Repository | Role |
| --- | --- |
| `backend` | this repository |
| `frontend` | Next.js client |
| `socket` | WebSocket delivery for chat, typing and presence |
| `infra` | compose files, nginx, certificates, server scripts |

## Where it sits

```
browser  --HTTPS /api-->  nginx  -->  this process :3001
                                      |- MongoDB
                                      |- uploads on disk (UPLOADS_DIR)
                                      |- mail
                                      `- Redis publish scribo:events
```

Port 3001 is not exposed outside the machine. Clients talk to the public host; nginx proxies the path through unchanged, so `/api/posts` at the edge is still `/api/posts` here.

Startup prints three lines and nothing else under normal operation: Mongo connected, uploads directory ready, port listening. The Nest route table is not logged. Errors and warnings still are.

## How it talks to the rest of the system

The browser gets an access JWT from this service and sends it as `Authorization: Bearer`. The `socket` service verifies the same token with the RS256 **public** key; it never receives the private key or the refresh secret, and it exits at startup if either is present in its environment.

Writes always come here over HTTP. After a write that someone should hear about — a new chat message, a read receipt, a group change — this service publishes `{ room, event, payload }` to the Redis channel `scribo:events`. The socket service fans it out to the sockets subscribed to `user:<id>` or `chat:<id>`. The two services share a MongoDB: the socket reads conversation membership from it so that a client cannot subscribe to a chat it does not belong to.

Uploaded images are written to a directory on disk and referenced in the database by path only, never by absolute URL. In production nginx serves that directory directly and read-only.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | NestJS 11 on the Express adapter |
| Database | MongoDB with Mongoose |
| Auth | RS256. Access JWT in `Authorization: Bearer`; refresh signed with a separate secret and held in the httpOnly `refresh_token` cookie |
| Files | local disk, served at `/uploads/...` |
| Mail | Nodemailer over Gmail |
| Events | Redis, channel `scribo:events` |
| Contract | OpenAPI 3 with Swagger |

Every JSON response is wrapped in `{ status, message, data }`. Validation and domain errors use the same envelope.

## What the API does

**Accounts.** Registration and sign-in by e-mail or through Google, e-mail confirmation codes, password reset, session list, refresh and sign-out. The Google flow accepts a Google access token and calls userinfo itself; the client id lives in the frontend.

**Content.** Profiles, follows, saved posts. Posts with categories, hashtags, a cover image and a view counter that increments when an article is opened. Nested comments. Search over posts and comments with hashtag suggestions. Link previews. Support tickets.

**Conversations.** Both direct conversations and group chats are stored here. A group has a title, a description, a photo, a member list and per-member roles (`admin` or `member`). Group endpoints cover creation, editing, adding and removing members, promoting and demoting admins, leaving, and a public invite that lets a signed-in non-member look at the group and join it:

```
GET    /api/chat/conversations/:id/invite    public, title/photo/member count
POST   /api/chat/conversations/:id/join      join an existing group
```

Messages, read receipts, edits and deletions are written to Mongo and then published to Redis; the socket service only delivers them. Typing indicators never reach this service at all — they are socket-to-socket through Redis, because they are not state worth persisting.

**Administration.** Users and roles, categories, an action journal, an analytics summary and the backup console. Roles are `user`, `author`, `moderator`, `admin` and `tech_admin`.

Routes require an access JWT by default. Public ones are marked `@Public()`. `@OptionalAuth()` serves a page to a guest but still attaches the user when a token is present; that is how article pages work. Sensitive routes are rate limited. The view counter is an exception: exceeding its limit does not return 429, the view simply is not counted.

## Requirements

Node.js 22. MongoDB, either Atlas or local. A writable directory for uploads. A Gmail app password for mail. Redis for events — in production it is started by the compose stack in `infra`.

## Running locally

```bash
cp .env.example .env
npm install
npm run start:dev
```

Listens on `http://localhost:3001`.

| Check | URL |
| --- | --- |
| Health, outside the `/api` prefix | `GET /health` |
| Ping | `GET /api` |
| OpenAPI in the application envelope | `GET /api/docs` |
| Swagger UI | `GET /api/swagger` |
| Raw OpenAPI | `GET /api/docs-json` |

`FRONTEND_ORIGIN` must match the origin of the frontend exactly — `http://localhost:3000` locally, the public host in production. CORS admits that origin; outside production it additionally admits localhost.

## Environment

`.env` is not committed. See `.env.example`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | no | `3001` by default |
| `MONGODB_URI` | yes* | Full connection string. When set, the `DB_*` parts are ignored |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_NAME` | yes* | Used when `MONGODB_URI` is empty. `DB_HOST` is the cluster host only |
| `JWT_PRIVATE_KEY` | yes | RS256 private key, PEM. Signs access tokens |
| `JWT_PUBLIC_KEY` | yes | RS256 public key. Verifies access tokens here and in the socket service |
| `JWT_REFRESH_KEY` | yes | Separate refresh secret |
| `PASSWORD_SALT` | no | bcrypt rounds, `10` by default |
| `CHAT_ENCRYPTION_KEYS` | yes | Chat text keys as `id:secret,id:secret`. Keep old ids until everything is re-encrypted |
| `CHAT_ENCRYPTION_ACTIVE_KEY` | yes | The id from the list that new messages are encrypted with |
| `FRONTEND_ORIGIN` | in production | CORS origin and the base of links in e-mails, no trailing slash |
| `API_ORIGIN` | no | Public origin advertised in OpenAPI |
| `MAIL_SENDER`, `MAIL_PASSWORD` | for mail | Gmail account and app password |
| `UPLOADS_DIR` | no | Uploads directory, `./uploads` by default. `/app/uploads` in Docker, bind-mounted from the host |
| `UPLOADS_PUBLIC_URL` | no | Public address of that directory for logs, `<API_ORIGIN>/uploads` by default. The domain is never stored in the database |
| `SERVE_UPLOADS` | no | Whether Node serves `/uploads` itself. Enabled outside production by default |
| `BACKUP_ENABLED` | no | Enables the schedule and the admin button. Off by default |
| `BACKUP_RESTORE_ENABLED` | no | Enables restore and archive upload. Off by default |
| `BACKUPS_DIR` | no | Archive directory, `./backups` by default, `/app/backups` in Docker |
| `BACKUP_AT` | no | Daily run time in UTC, `04:15` by default |
| `BACKUP_KEEP_DAILY_DAYS` | no | Days kept at one backup per day, `7` by default |
| `BACKUP_KEEP_MONTHS` | no | Months kept at one backup per month, `12` by default |
| `BACKUP_KEEP_UPLOADED` | no | How many manually uploaded archives are kept, `3` by default |
| `BACKUP_UPLOAD_MAX_MB` | no | Largest uploadable archive in MB, `2048` by default. The nginx limit for that route is 4 GB |
| `MONGODUMP_BIN`, `TAR_BIN` | no | Paths to `mongodump` and `tar`, taken from `PATH` by default |
| `REDIS_URL` | yes | `redis://127.0.0.1:6379` from the host, `redis://redis:6379` inside compose |

\* Either `MONGODB_URI`, or all four `DB_*` values.

## Files

File handling is isolated in `src/files`, the same way the database is isolated in `src/database`. Application services only call `FilesService.saveImage(...)` and `FilesService.remove(url)`; where the bytes actually live is known to that layer alone (`FilesDisk` writes to disk, `files.config.ts` computes paths and public URLs).

Images are stored under `UPLOADS_DIR/src/<kind>/<id>.<ext>`, where the kind is `avatar`, `featured_image` or `group`. Files are mode 644, directories 755, and intermediate directories are created on first write — adding a new kind requires no manual setup on the server. The database stores the path `/uploads/src/...` without a domain; the client prefixes the origin of its own environment.

In production the directory is served by the nginx container of the `edge` stack, straight from the bind mount and read-only, so Node never streams an image. In development, with no nginx in front, the backend serves it itself (`SERVE_UPLOADS`, on by default outside `NODE_ENV=production`). Legacy S3 URLs still in the database keep working, but such files are not deleted when a post or avatar changes. `backend/uploads` is not tracked in git.

## Chat encryption

Message text is encrypted before it reaches MongoDB, so a database dump or a backup never contains it in the clear. Only the body is encrypted: `chat_messages.text` and the preview `conversations.last_message_text`. Sender, time, replies and system events stay readable. The logic is in `src/modules/chat/chat-crypto.ts` and is used by `ChatService`.

Each value is stored as `enc:v1:<key id>:<base64>`: AES-256-GCM with a fresh IV, the key derived from the secret with SHA-256. The key id selects the secret on read, so several keys can coexist. Plain text is not accepted: reading a value without the prefix is an error, and the backend does not start without `CHAT_ENCRYPTION_KEYS` and `CHAT_ENCRYPTION_ACTIVE_KEY`.

```bash
CHAT_ENCRYPTION_KEYS=k1:first-secret,k2:second-secret
CHAT_ENCRYPTION_ACTIVE_KEY=k2
```

Rotating a key: add the new id, make it active and restart, run the re-encrypt script, then drop the old id. Archives made before the last step still need the old key to be read after a restore. Losing a key makes the texts it protected unrecoverable.

The re-encrypt script brings every stored text to the active key. It also encrypts plain text, which is how the first rollout migrates existing messages. It is safe to run again and while the backend is up: a write only applies if the value is still the one that was read.

```bash
npm run chat:reencrypt -- --dry-run     # count only
npm run chat:reencrypt
./scribo dc prod exec backend node dist/modules/chat/reencrypt-chat.js
```

## Backups

Implemented in `src/modules/backups`. A backup is a single file `scribo-YYYYMMDD-HHMMSS.tar` (UTC) in `BACKUPS_DIR` containing:

```
manifest.json         ties the database dump and the uploads together; required for restore
mongo.archive.gz      mongodump --gzip --archive
uploads/              the entire uploads directory
```

It runs daily at `BACKUP_AT` (UTC) and on demand from the Backups tab of the admin panel. The tab and `/api/backups` are restricted to `tech_admin`, because the archive contains password hashes and every conversation.

**Every run is its own file.** A manual backup does not replace anything, it is added to today's set. The archive is assembled in a temporary file and appears whole, so a failed run cannot leave a half-written backup behind.

**Retention.** After each successful backup the surplus is deleted, counted in UTC days:

| Age | What is kept |
| --- | --- |
| Today | everything, including manual runs |
| The previous `BACKUP_KEEP_DAILY_DAYS` days (7) | one per day, the last one of that day |
| Older, up to `BACKUP_KEEP_MONTHS` months (12) | one per month, the last backup of that month |

"Last" is computed over the whole history including already deleted entries, so the role never slides to the second-to-last backup. History rows remain; a deleted file simply loses its Download and Restore buttons.

Each run writes a row into the `backups` collection: time, kind (`schedule` or `manual`), status (`running`, `success`, `failed`), size, error and who started it. Only one backup or restore runs at a time. `running` rows left behind by a crashed process are marked `failed` at startup and their temporary files are removed.

The connection string is handed to `mongodump` through a 0600 temporary file rather than an argument, so the password appears neither in the process list nor in stored error text. While an archive is being assembled a temporary dump sits next to the finished files, so the disk needs headroom for roughly one extra backup.

### Restore

The Restore button installs a backup's database and uploads over the current ones. It is enabled separately: `BACKUP_RESTORE_ENABLED=true` alongside `BACKUP_ENABLED=true`, off by default. The `restore_backups` permission belongs to `tech_admin` only. The endpoint is `POST /api/backups/:id/restore` with `{ "confirm": true }`, and progress is reported through `GET /api/backups` (`status.restoring`, `status.restore_job`, `status.current`, `status.last_restore`).

**The manifest.** Every archive carries `manifest.json`: backup id, time, database name, collection list, sha256 and size of the dump, file count and byte size of the uploads, the application version, and `based_on` — which backup the system was running when this one was taken. It binds the database and the file storage into one unit and is what the archive is validated against. Archives taken before the manifest existed cannot be restored.

**Order of operations:**

1. The archive is unpacked and verified: manifest, database name, dump checksum, file count. If anything fails, nothing has been touched.
2. A safety snapshot of the current state is taken as `scribo-pre-restore-….tar`. It is exempt from the one-per-day rule and only one is kept (`BACKUP_KEEP_PRE_RESTORE`, default 1): older ones are deleted as soon as a new one exists. After a successful restore the snapshot is deleted and its history row remains; after a failed one it is kept for manual recovery.
3. `mongorestore --drop`, then collections absent from the backup are dropped. The `backups` history itself is excluded from restore.
4. The uploads directory is emptied and refilled from the archive.
5. If steps 3 or 4 fail, the system rolls itself back to the safety snapshot.

While a restore is running the backend answers 503 to every mutating request except `/api/backups`; reads keep working and no restart is needed. Sessions are restored along with the database, so some users will have to sign in again.

**Uploading an archive.** The Upload backup button accepts a `.tar` produced by Scribo — downloaded from this admin panel, from another environment, or from disk: `POST /api/backups/upload`, multipart, field `file`, permissions `manage_backups` and `restore_backups`, only while `BACKUP_RESTORE_ENABLED=true`. It is not installed on arrival: it is validated, listed as "uploaded manually", and installed later through the usual Restore button with confirmation and a safety snapshot. An uploaded archive is untrusted, so it is checked before and after unpacking:

- from the tar headers, without unpacking: regular files and directories only (links, devices and the like are rejected), no absolute or `..` paths, exactly `manifest.json`, `mongo.archive.gz` and the uploads directory named in the manifest, no duplicates, file count and sizes matching the manifest, bounded uncompressed size;
- a well-formed manifest whose data version equals the current one (the database name does not matter);
- after unpacking: dump size and sha256, upload file count and byte count;
- the dump itself: a complete gzip stream in `mongodump --archive` format.

Re-uploading an archive that is already listed is rejected. The last `BACKUP_KEEP_UPLOADED` uploads are kept. Validation holds the same lock as backup and restore. Behind nginx the upload route has its own location with a 4 GB body limit, buffering disabled and a 15 minute timeout. The journal records `backup_upload` and `backup_upload_failed`.

**Where "which backup am I on" lives.** In `state.json` next to the archives, not in the database, because the database is replaced wholesale during a restore. Recent restores are recorded there too. `restore.lock` exists only while a restore is in progress; if it survives a crash, the restore is marked interrupted at startup and the admin panel offers the safety snapshot.

The database name does not constrain a restore: the backup is installed into whichever database the backend is connected to, renamed on the fly (`mongorestore --nsFrom=<name in archive>.$col$ --nsTo=<current>.$col$`). A staging archive therefore installs into a local or production database without editing `.env`. Compatibility is decided by the data version instead.

**Data version.** The major and minor of the backend version in `package.json`: `6.1.2` yields `6.1`. It is never bumped by hand, it follows `version`. A patch release does not change the data format; a feature release raises the minor and makes archives of the previous minor incompatible. Restore and upload require an exact match. On every start the backend writes the data version and the full application version into the `app_meta` collection (document `_id: "db"`) and records any change in the journal (`db_version_sync`). A restore reapplies the same record afterwards, so it always reflects the running backend. `db.version` and `app_version` are written into every manifest and history row; for older archives the data version is derived from `app_version`. The comparison rule lives in `incompatibility()` in `db-version.ts`.

`BACKUP_ENABLED=false` disables everything: the schedule does not start and manual runs answer 409. Staging runs with `false`.

Manual recovery, if the admin panel is unavailable:

```bash
tar -xf scribo-2026-10-02.tar
mongorestore --gzip --archive=mongo.archive.gz --uri="$MONGODB_URI" --drop
cp -a uploads/. /srv/scribo/prod/uploads/
```

The image installs `mongodump` and GNU `tar` from the Alpine packages `mongodb-tools` and `tar`. Locally both must be on `PATH`.

## Local MongoDB in Docker

From `infra/local` in the infra repository: `docker compose up -d --build` brings up everything (Mongo, Redis, backend, socket, frontend), `docker compose down` stops it, `docker compose up -d redis mongo` starts only the datastores. `docker compose down -v` erases the Mongo volume.

To run the applications by hand with only the datastores in Docker:

```bash
cd infra/local && docker compose up -d mongo redis
```

Then in `backend/.env` and `socket/.env`:

```
MONGODB_URI=mongodb://scribo:scribo@127.0.0.1:27017/scribo?authSource=admin
```

`MONGODB_URI` takes precedence over the `DB_*` values, so returning to Atlas is a matter of commenting that line out. The socket service additionally needs `DB_NAME=scribo`; the database name must match the backend. Data lives in the `scribo-mongo-data` volume. To inspect it: `docker exec -it scribo-mongo mongosh -u scribo -p scribo --authenticationDatabase admin scribo`.

## Scripts

```bash
npm run start:dev
npm run start
npm run start:prod
npm run build
npm run lint
npm run lint:check
npm run test
npm run test:e2e
npm run test:cov
npm run chat:reencrypt
```

## Layout

```
src/
  main.ts              startup, Mongo and uploads checks, port
  create-app.ts        CORS, cookies, validation, static uploads, Swagger
  app.module.ts
  authz/               JWT guard, roles, permissions
  http/                response envelope, errors, rate limits
  visitor/             IP, geo, device
  validation/          field limits and DTOs
  infra/               mail, logger into Mongo, startup checks
  config/              environment, Mongo URI, JWT keys
  database/            Mongoose connection and schemas
  files/               uploads: service, disk, config, interceptors
  socket/              event publishing into Redis
  modules/
    auth/              registration, sign-in, sessions, reset
    users/             users and roles
    profile/
    categories/
    posts/             posts and comments
    search/
    support/
    logs/
    analytics/
    notifications/
    chat/              direct conversations, groups, messages
    backups/
    link-preview/
```

## Client session flow

1. Sign-in and registration return `accessToken` in `data` and set the `refresh_token` cookie.
2. Normal requests carry `Authorization: Bearer <accessToken>`.
3. `POST /api/auth/refresh` is sent with the cookie and `credentials: include`.
4. Google sign-in posts `googleToken`.

`trust proxy` is enabled behind the reverse proxy, so Secure cookies and the real client IP are taken from the nginx headers.

## Deployment

A push to `master` builds `ghcr.io/scribo-blog-org/backend` on an ARM runner, publishes the `latest` and commit-sha tags and restarts the `backend` service of the `prod` stack over SSH. A push to `dev` does the same with the `staging` tag against the `stage` stack. Pull requests run lint, test and a local `docker build` without publishing.

The machine, nginx, Redis and the compose layout are documented in the `infra` repository.
