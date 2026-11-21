import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) {
    return path.resolve(process.env.MIGRATIONS_DIR);
  }

  const fromCwd = path.resolve(process.cwd(), "lib/db/migrations");
  if (fs.existsSync(fromCwd)) return fromCwd;

  // The API server is bundled into artifacts/api-server/dist, so walk back to
  // the repository root to find the committed migrations.
  return path.resolve(__dirname, "../../../lib/db/migrations");
}

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}

export * from "./schema";
