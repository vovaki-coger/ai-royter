# NVIDIA AI Router

Приватный дашборд для подключения AI-провайдеров и маршрутизации
OpenAI-совместимых запросов через собственные ключи.

Приложение умеет:

- подключать NVIDIA NIM, OpenRouter, DeepSeek, OpenAI и любые
  OpenAI-совместимые HTTPS-эндпоинты;
- находить модели провайдера и хранить их каталог;
- выпускать и отзывать ключи роутера вида `air_...`;
- проксировать `POST /api/v1/chat/completions` и `POST /api/v1/responses`
  с поддержкой streaming;
- показывать историю запросов и статистику;
- шифровать ключи провайдеров на сервере (AES-256-GCM, `SESSION_SECRET`).

## Деплой на Render

В репозитории уже есть `render.yaml`: Render создаст PostgreSQL и один
Node-сервис, который отдаёт и API, и собранный React-фронтенд с одного
домена. Отдельный static site не нужен.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vovaki-coger/ai-royter)

1. Откройте Render Dashboard → **New** → **Blueprint** и подключите
   репозиторий `vovaki-coger/ai-royter`.
2. Render попросит заполнить переменные без значений:
   - `CLERK_PUBLISHABLE_KEY` — publishable key из Clerk;
   - `CLERK_SECRET_KEY` — secret key из Clerk (только сервер).

   Blueprint сам передаёт publishable key в сборку фронтенда как
   `VITE_CLERK_PUBLISHABLE_KEY`, поэтому вводить его дважды не нужно.
3. Нажмите **Apply**. Render создаст базу, соберёт проект и запустит
   сервис. Миграции БД применяются автоматически при старте.
4. После первого деплоя откройте URL вида
   `https://ai-router-xxxx.onrender.com` и проверьте `/api/healthz`.

### Clerk

1. Создайте приложение на [dashboard.clerk.com](https://dashboard.clerk.com).
2. Скопируйте **Publishable key** и **Secret key**.
3. Добавьте домен Render (`https://<service>.onrender.com`) в разрешённые
   домены/origins приложения Clerk.
4. Если позже меняете `VITE_CLERK_PUBLISHABLE_KEY`, сделайте
   **Manual Deploy → Clear build cache & deploy**: Vite встраивает
   переменную на этапе сборки.

Приложение также умеет работать через Clerk proxy
(`/api/__clerk`). Для этого задайте `VITE_CLERK_PROXY_URL=/api/__clerk`
при сборке и настройте proxy URL в Clerk Dashboard. По умолчанию proxy
выключен, и браузер обращается к Clerk напрямую.

### Переменные окружения

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | да | PostgreSQL. Render подставляет из Blueprint. |
| `SESSION_SECRET` | да | Шифрование ключей провайдеров. Render генерирует автоматически. Не меняйте после сохранения ключей. |
| `CLERK_PUBLISHABLE_KEY` | да | Clerk publishable key для API. |
| `CLERK_SECRET_KEY` | да | Clerk secret key. |
| `VITE_CLERK_PUBLISHABLE_KEY` | да (build-time) | Publishable key для фронтенда. На Render Blueprint подставляет его из `CLERK_PUBLISHABLE_KEY`. |
| `PORT` | да (Render) | Render задаёт сам. Локально — `5000`. |
| `SERVE_WEB` | нет | `false` отключает раздачу фронтенда из API-сервиса. |
| `WEB_DIST_DIR` | нет | Путь к собранному фронтенду, если он лежит нестандартно. |
| `MIGRATIONS_DIR` | нет | Путь к миграциям Drizzle. |
| `RUN_MIGRATIONS` | нет | `false` отключает автоматические миграции при старте. |
| `MIGRATION_ATTEMPTS` | нет | Сколько раз пытаться применить миграции при старте (по умолчанию 10). |
| `VITE_CLERK_PROXY_URL` | нет | Например `/api/__clerk`, если используете Clerk proxy. |

### Особенности free-плана Render

- Web Service засыпает после простоя: первый запрос может идти дольше.
- Free PostgreSQL на Render имеет ограниченный срок жизни — проверьте
  актуальные условия Render и при необходимости перейдите на платный план.
- Для нескольких инстансов автоматические миграции при старте лучше
  заменить на Render `preDeployCommand`, чтобы избежать гонки.

## Локальный запуск

Нужны Node.js 24+ и pnpm 10+.

> В `pnpm-workspace.yaml` оставлены только Linux-бинарники нативных
> зависимостей, чтобы уменьшить размер деплоя на Render. Для локальной
> разработки на Windows используйте WSL или уберите соответствующие
> `overrides` для `win32-x64`.

```bash
corepack enable
pnpm install
cp .env.example .env
# заполните DATABASE_URL, SESSION_SECRET и ключи Clerk в .env
```

Примените схему к локальной базе:

```bash
pnpm --filter @workspace/db run push
```

Запустите API и фронтенд в двух терминалах:

```bash
# API на http://localhost:5000
pnpm --filter @workspace/api-server run dev

# Vite на http://localhost:5173, /api проксируется на :5000
pnpm --filter @workspace/ai-router run dev
```

Проверка типов и сборка:

```bash
pnpm run typecheck
pnpm run build:render
```

### Миграции

После изменения схемы в `lib/db/src/schema` сгенерируйте новую миграцию
и закоммитьте её:

```bash
pnpm --filter @workspace/db exec drizzle-kit generate --name describe_change
```

При старте API применит все неприменённые миграции из
`lib/db/migrations`.

## Использование роутера

1. Войдите в дашборд и подключите провайдера на странице **Providers**.
2. Создайте ключ на странице **Keys** — полный ключ показывается один раз.
3. Используйте base URL вашего Render-сервиса:

```bash
curl https://<service>.onrender.com/api/v1/chat/completions \
  -H "Authorization: Bearer air_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<provider-slug>/<model-id>",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

Список доступных моделей: `GET /api/v1/models` с тем же заголовком
`Authorization`.

## Структура

- `artifacts/ai-router` — React/Vite интерфейс.
- `artifacts/api-server` — Express API и проксирование запросов.
- `lib/db` — схема PostgreSQL, Drizzle ORM и миграции.
- `lib/api-spec` — OpenAPI-контракт и кодогенерация.
- `render.yaml` — Blueprint для Render.

## Безопасность

- Ключи провайдеров шифруются на сервере и никогда не отдаются браузеру.
- Ключи роутера хранятся в виде SHA-256 хэша; полный ключ виден только
  при создании.
- Не коммитьте `.env` и не меняйте `SESSION_SECRET` без переподключения
  провайдеров.
