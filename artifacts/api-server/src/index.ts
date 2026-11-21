import { runMigrations } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function applyMigrations(): Promise<void> {
  const attempts = Number(process.env.MIGRATION_ATTEMPTS ?? 10);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrations();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn(
        { err: error, attempt },
        "Database is not ready yet; retrying migrations",
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

async function start(): Promise<void> {
  if (process.env.RUN_MIGRATIONS !== "false") {
    await applyMigrations();
    logger.info("Database migrations applied");
  }

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  server.timeout = 0;
}

start().catch((error) => {
  logger.error({ err: error }, "Server failed to start");
  process.exit(1);
});
