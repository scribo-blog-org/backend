# Scribo API

HTTP API блога. Аккаунты, посты, комментарии, поиск, переписка, поддержка и админские данные. Реалтайм этот процесс не держит: события он публикует в Redis, а браузеру их отдаёт сервис `socket`.

Прод: `https://scribo-blog.duckdns.org/api`. Рядом в том же хосте живут фронт и сокет; как nginx их разделяет, описано в репозитории `infra`.

## Место в системе

```
браузер  --HTTPS /api-->  nginx  -->  этот процесс :3001
                                      ├─ MongoDB Atlas
                                      ├─ S3
                                      ├─ почта
                                      └─ Redis publish scribo:events
```

Порт 3001 снаружи машины не открыт. Клиент ходит на публичный хост, nginx срезает префикс пути и проксирует его сюда как есть: `/api/posts` на входе nginx остаётся `/api/posts` у Nest.

Старт печатает три строки и больше ничего штатного: Mongo подключена, S3 доступна, порт слушается. Карту маршрутов Nest в лог не пишет. Ошибки и предупреждения остаются.

## Стек

| Слой | Выбор |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | NestJS 11, адаптер Express |
| База | MongoDB, Mongoose |
| Доступ | RS256. Access JWT в `Authorization: Bearer`. Refresh — отдельный секрет, httpOnly cookie `refresh_token` |
| Файлы | AWS S3 |
| Почта | Nodemailer, Gmail |
| События | Redis, канал `scribo:events` |
| Контракт | OpenAPI 3, Swagger |

Каждый JSON-ответ в конверте `{ status, message, data }`. Ошибки валидации и домена имеют ту же форму.

## Что делает API

Регистрация и вход по почте и через Google. Коды подтверждения почты, сброс пароля, список сессий, refresh и выход. Google-логин принимает access token Google и сам ходит в userinfo. Client id живёт на фронте.

Профили, подписки, сохранённые посты. Посты: создание и правка, категории, хештеги, обложка, счётчик просмотров при открытии статьи. Вложенные комментарии. Поиск по постам и комментариям, подсказки хештегов. Превью ссылок. Тикеты поддержки.

Переписка хранится здесь. Новое сообщение и прочтение пишутся в Mongo и публикуются в Redis. Сокет только доставляет событие в комнату `chat:<id>` или `user:<id>`.

Админка: пользователи и роли, категории, журнал действий, сводка аналитики. Роли: `user`, `author`, `moderator`, `admin`, `tech_admin`.

Маршруты по умолчанию требуют access JWT. Публичные помечены `@Public()`. `@OptionalAuth()` отдаёт страницу гостю и всё равно прикладывает пользователя, если токен есть. Так устроен просмотр статьи.

На чувствительных маршрутах стоит лимит. Лимит просмотра не отвечает 429: просмотр просто не увеличивается.

## Требования

Node.js 22. MongoDB, Atlas или локальная. Для загрузок — S3. Для писем — пароль приложения Gmail. Для событий — Redis. На проде Redis поднимает compose из `infra`.

## Локальный запуск

```bash
cp .env.example .env
npm install
npm run start:dev
```

Слушает `http://localhost:3001`.

| Проверка | URL |
| --- | --- |
| Health, без префикса `/api` | `GET /health` |
| Ping | `GET /api` |
| OpenAPI в конверте приложения | `GET /api/docs` |
| Swagger UI | `GET /api/swagger` |
| Сырой OpenAPI | `GET /api/docs-json` |

`FRONTEND_ORIGIN` должен совпадать с origin фронта. Локально это обычно `http://localhost:3000`. В проде — `https://scribo-blog.duckdns.org`. CORS пускает этот origin. В не-production дополнительно пускает localhost.

## Окружение

Файл `.env` не коммитится. Образец — `.env.example`.

| Переменная | Обязательна | Смысл |
| --- | --- | --- |
| `PORT` | нет | По умолчанию `3001` |
| `MONGODB_URI` | да* | Полная строка. Если задана, части `DB_*` не используются |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_NAME` | да* | Когда `MONGODB_URI` пустой. `DB_HOST` — только хост кластера |
| `JWT_PRIVATE_KEY` | да | Закрытый ключ RS256, PEM. Им подписывается access token |
| `JWT_PUBLIC_KEY` | да | Открытый ключ RS256. Им API проверяет access token. Тот же ключ получает socket |
| `JWT_REFRESH_KEY` | да | Отдельный секрет refresh. Без него refresh не подписывается |
| `PASSWORD_SALT` | нет | Раунды bcrypt, по умолчанию `10` |
| `FRONTEND_ORIGIN` | да в проде | CORS и ссылки в письмах, без слэша на конце |
| `API_ORIGIN` | нет | Публичный origin в OpenAPI |
| `MAIL_SENDER`, `MAIL_PASSWORD` | для почты | Ящик Gmail и пароль приложения |
| `AWS_CONNECT_ACCESS_KEY`, `AWS_CONNECT_SECRET_ACCESS_KEY`, `AWS_CONNECT_REGION`, `AWS_CONNECT_BUCKET_NAME` | для загрузок | S3 |
| `REDIS_URL` | да | С хоста `redis://127.0.0.1:6379`. В compose `redis://redis:6379` |

\* Либо `MONGODB_URI`, либо все четыре `DB_*`.

Закрытый ключ и секрет refresh на сокет не передаются. Сокет умеет только проверять access token открытым ключом.

## Скрипты

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
```

## Как устроен код

```
src/
  main.ts              старт, проверка Mongo и S3, порт
  create-app.ts        CORS, cookie, валидация, Swagger
  app.module.ts
  authz/               guard JWT, роли, права
  http/                конверт ответа, ошибки, лимиты
  visitor/             IP, гео, устройство
  validation/          лимиты полей и DTO
  infra/               почта, S3, журнал в Mongo, проверки старта
  config/              env, URI Mongo, ключи JWT
  database/            Mongoose и схемы
  socket/              публикация событий в Redis
  modules/
    auth/              регистрация, вход, сессии, сброс
    users/             пользователи и роли
    profile/
    categories/
    posts/             посты и комментарии
    search/
    support/
    logs/
    analytics/
    notifications/
    chat/
    link-preview/
```

## Сессия для клиента

1. Вход и регистрация возвращают `accessToken` в `data` и ставят cookie `refresh_token`.
2. Обычные запросы идут с `Authorization: Bearer <accessToken>`.
3. `POST /api/auth/refresh` идёт с cookie, `credentials: include`.
4. Google-вход присылает `googleToken`.

За reverse proxy включён `trust proxy`: Secure cookie и реальный IP клиента берутся из заголовков nginx.

## Выкладка

Push в `master` собирает образ `ghcr.io/scribo-blog-org/backend`, теги `latest` и sha, и по SSH поднимает сервис `backend` в `/opt/scribo`. Pull request в `master` гоняет lint, test и `docker build` без публикации. Подробности машины — в `infra`.
