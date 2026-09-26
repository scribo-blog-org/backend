# Scribo API

HTTP API for the Scribo blog platform: accounts, posts, comments, search, support, and admin analytics.

Built with **NestJS 11**, **MongoDB (Mongoose)**, and **JWT**. The live frontend is `Scribo_frontend` in the same workspace.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | NestJS 11 (Express adapter) |
| Database | MongoDB via Mongoose 9 |
| Auth | Access JWT (`Authorization: Bearer`) + `refresh_token` httpOnly cookie |
| Uploads | AWS S3 |
| Mail | Nodemailer (Gmail) |
| Docs | OpenAPI 3 / Swagger |

## What it covers

- Email and Google registration / login, email verification codes, password reset
- Session list, refresh, and logout (refresh cookie)
- Profiles, follows, saved posts
- Posts (CRUD, categories, hashtags, cover images, view counting on article fetch)
- Nested comments
- Full-text style search over posts and comments, hashtag suggest
- Support tickets
- Admin: users/roles, categories, logs, analytics dashboard data
- RBAC: `user`, `author`, `moderator`, `admin`, `tech_admin`

Every JSON response uses the envelope `{ status, message, data }`. Validation and domain errors follow the same shape.

## Requirements

- Node.js **22.x**
- MongoDB (Atlas URI or local)
- Optional: AWS S3 (media), Gmail app password (mail), Google OAuth client on the frontend

## Setup

```bash
cd Scribo_nest
cp .env.example .env
npm install
```

Fill `.env`, then:

```bash
npm run start:dev
```

Default listen address: `http://localhost:3001`.

| Check | URL |
| --- | --- |
| Health (no `/api` prefix) | `GET /health` |
| Ping | `GET /api` |
| OpenAPI JSON (app envelope) | `GET /api/docs` |
| Swagger UI | `GET /api/swagger` |
| Raw OpenAPI JSON | `GET /api/docs-json` |

Pair with the frontend: set `FRONTEND_ORIGIN` to the Vite origin (usually `http://localhost:3000`) and set the frontend `VITE_APP_API_URL` to `http://localhost:3001`. CORS allows `FRONTEND_ORIGIN`, `*.vercel.app`, and local `http://localhost` / `http://127.0.0.1` when not in production.

## Environment

Copy `.env.example`. Do not commit `.env`.

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | no | Default `3001` |
| `MONGODB_URI` | yes* | Full connection string. If set, `DB_USER` / `DB_PASSWORD` / `DB_NAME` are ignored |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | yes* | Used when `MONGODB_URI` is empty. `DB_NAME` is the database in the Atlas URI |
| `JWTKEY` | yes | Access-token secret |
| `JWT_REFRESH_KEY` | yes | Refresh-token secret. Separate from `JWTKEY`; refresh is not signed without it |
| `PASSWORD_SALT` | no | bcrypt rounds, default `10` |
| `FRONTEND_ORIGIN` | yes in prod | Allowed browser origin for CORS and email links |
| `API_ORIGIN` | no | Public API origin in OpenAPI (`http://localhost:3001` locally) |
| `MAIL_SENDER` | for mail | Gmail address |
| `MAIL_PASSWORD` | for mail | Gmail app password |
| `AWS_CONNECT_ACCESS_KEY` | for uploads | S3 access key |
| `AWS_CONNECT_SECRET_ACCESS_KEY` | for uploads | S3 secret |
| `AWS_CONNECT_REGION` | for uploads | e.g. `eu-central-1` |
| `AWS_CONNECT_BUCKET_NAME` | for uploads | Bucket name |
| `SUPABASE_URL` | yes | Supabase project URL for realtime |
| `SUPABASE_SECRET_KEY` | yes | Supabase secret key, server only |
| `SOCKET_JWT_SECRET_KEY` | yes | PEM private key for socket tokens |
| `SOCKET_JWT_PUBLIC_KEY` | yes | PEM public key for socket tokens |
| `SOCKET_JWT_KID` | no | Key id on the socket JWT |

\* Provide either `MONGODB_URI` or all of `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.

## Scripts

```bash
npm run start:dev    # watch
npm run start        # once
npm run start:prod   # node dist/main (after build)
npm run build
npm run lint         # ESLint --fix
npm run lint:check
npm run format       # Prettier
npm run test         # unit (Jest)
npm run test:e2e
npm run test:cov
```

## Layout

```
src/
  main.ts                 bootstrap
  create-app.ts           CORS, cookies, validation, Swagger
  app.module.ts
  authz/                  JWT guard, permissions, roles
  common/                 envelope, mail, S3, rate limit, OpenAPI handle
  database/               Mongoose module + schemas
  modules/
    auth/                 register, login, sessions, reset
    users/                admin user + role APIs
    profile/
    categories/
    posts/                posts + comments
    search/
    support/
    logs/
    analytics/
```

Guards: routes are authenticated by default. Mark public handlers with `@Public()`; use `@OptionalAuth()` when a view should work for guests but still attach a user when a token is present (article views).

## Auth (clients)

1. Login/register returns `accessToken` in `data` and sets `refresh_token` (httpOnly).
2. Send `Authorization: Bearer <accessToken>` on API calls.
3. Send cookies (`credentials: include`) on `POST /api/auth/refresh`.
4. Google login sends the Google access token as `googleToken`; the API calls Google userinfo. The OAuth client id lives on the frontend.

Rate limits apply to sensitive routes (auth, views). Hitting a view-rate limit skips the increment instead of returning 429.

## Production notes

- Set `NODE_ENV=production` (or Vercel production). Localhost CORS shortcuts are then off.
- `trust proxy` is enabled so Secure cookies and client IP work behind Vercel / a reverse proxy.
- Keep JWT secrets and Mongo credentials only in the host’s env store.

The older Express app in `Scribo_backend` is not this API.
