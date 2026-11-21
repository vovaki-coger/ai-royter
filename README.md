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

## Деплой: Fly.io (веб) + Supabase (PostgreSQL)

Supabase используется как бесплатная PostgreSQL. Сам Node/Express-сервис
размещается на Fly.io: бесплатный слой, регион **`fra`** (Франкфурт, вне РФ,
нормально доступен из РФ) и полноценный долгоживущий Node-процесс, который
держит длинные streaming-ответы. Один сервис отдаёт и API, и собранный
React-фронтенд с одного домена.

В репозитории уже есть `Dockerfile` и `fly.toml` — сборка и запуск полностью
описаны, осталось только создать приложение и задать секреты.

### 1. Supabase

1. Создайте бесплатный проект на [supabase.com](https://supabase.com).
2. Зайдите в **Project Settings → Database → Connection string → URI**
   и скопируйте строку вида
   `postgresql://postgres.[ref]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`.
   Вместо `[PASSWORD]` подставьте пароль базы (он задаётся при создании
   проекта). Возьмите именно **Transaction pooler** (порт 6543).
3. Эту строку нужно будет добавить на Fly.io как `DATABASE_URL`.

Строка подключения включает пароль — не коммитьте её в репозиторий.

### 2. Fly.io

1. Зарегистрируйтесь на [fly.io](https://fly.io) (бесплатный слой требует
   карту для подтверждения, но списаний за free-ресурсы нет).
2. Создайте Personal Access Token:
   **https://fly.io/user/personal_access_tokens → Create Personal Access Token**.
   Скопируйте его (показывается один раз).
3. С токеном можно задеплоить из репозитория:

   ```bash
   flyctl auth login --token <токен>
   flyctl secrets set \
     DATABASE_URL="postgresql://..." \
     SESSION_SECRET="<длинная случайная строка>" \
     CLERK_PUBLISHABLE_KEY="pk_test_..." \
     CLERK_SECRET_KEY="sk_test_..."
   flyctl deploy
   ```

   Имя приложения и регион заданы в `fly.toml` (`ai-router-vovaki`, `fra`).
   Если имя занято — поменяйте `app` в `fly.toml`.
4. Миграции БД применяются автоматически при старте.
5. Проверьте `https://ai-router-vovaki.fly.dev/api/healthz` и `/api/config`.

Publishable key для фронтенда больше не встраивается при сборке: API отдаёт его
через публичный `GET /api/config`, поэтому после смены Clerk-ключей достаточно
обычного redeploy без очистки build-кэша.

### Clerk

1. Откройте ваше приложение на [dashboard.clerk.com](https://dashboard.clerk.com)
   и скопируйте **Publishable key** и **Secret key**.
2. Добавьте домен Fly.io (`https://ai-router-vovaki.fly.dev`) в разрешённые
   origins/domains приложения Clerk.
3. Приложение также умеет работать через Clerk proxy (`/api/__clerk`).
   Для этого задайте `VITE_CLERK_PROXY_URL=/api/__clerk` при сборке и
   настройте proxy URL в Clerk Dashboard. По умолчанию proxy выключен.

### Переменные окружения

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | да | PostgreSQL из Supabase (Transaction pooler, порт 6543). |
| `SESSION_SECRET` | да | Шифрование ключей провайдеров. Не меняйте после сохранения ключей. |
| `CLERK_PUBLISHABLE_KEY` | да | Clerk publishable key для API и для фронтенда (через `/api/config`). |
| `CLERK_SECRET_KEY` | да | Clerk secret key. |
| `PORT` | да | Fly.io задаёт сам (8080). Локально — `5000`. |
| `SERVE_WEB` | нет | `false` отключает раздачу фронтенда из API-сервиса. |
| `WEB_DIST_DIR` | нет | Путь к собранному фронтенду, если он лежит нестандартно. |
| `MIGRATIONS_DIR` | нет | Путь к миграциям Drizzle. |
| `RUN_MIGRATIONS` | нет | `false` отключает автоматические миграции при старте. |
| `MIGRATION_ATTEMPTS` | нет | Сколько раз пытаться применить миграции при старте (по умолчанию 10). |
| `VITE_CLERK_PUBLISHABLE_KEY` | нет | Только fallback для локальной разработки без API. |
| `VITE_CLERK_PROXY_URL` | нет | Например `/api/__clerk`, если используете Clerk proxy. |

### Бесплатные лимиты

- Supabase Free: PostgreSQL, лимиты по размеру БД и трафику — см. тарифы Supabase.
- Fly.io Free: shared-cpu-1x, 256 MB RAM; машина автоматически останавливается
  при простое и просыпается на первом запросе (первый запрос может быть медленнее).
- Для постоянной работы без простоя нужен платный слой Fly.io.

## Локальный запуск

Нужны Node.js 24+ и pnpm 10+.

> В `pnpm-workspace.yaml` оставлены только Linux-бинарники нативных
> зависимостей, чтобы уменьшить размер деплоя. Для локальной
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
