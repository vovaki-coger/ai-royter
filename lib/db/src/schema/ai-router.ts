import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const routerProvidersTable = pgTable(
  "router_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    providerSlug: varchar("provider_slug", { length: 63 }),
    name: varchar("name", { length: 80 }).notNull(),
    apiProtocol: varchar("api_protocol", { length: 40 })
      .notNull()
      .default("openai_chat_completions"),
    baseUrl: text("base_url").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    keyHint: varchar("key_hint", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("connected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [
    index("router_providers_user_idx").on(table.userId),
    uniqueIndex("router_providers_user_provider_slug_unique").on(
      table.userId,
      table.providerSlug,
    ),
  ],
);

export const routerProviderModelsTable = pgTable(
  "router_provider_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => routerProvidersTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    contextLength: integer("context_length"),
    inputModalities: text("input_modalities").array(),
    supportsVision: boolean("supports_vision"),
    unavailableUntil: timestamp("unavailable_until", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("router_provider_model_unique").on(
      table.providerId,
      table.modelId,
    ),
    index("router_provider_models_user_idx").on(table.userId),
  ],
);

export const routerKeysTable = pgTable(
  "router_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    prefix: varchar("prefix", { length: 24 }).notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("router_keys_user_idx").on(table.userId)],
);

export const routerRequestsTable = pgTable(
  "router_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    providerId: uuid("provider_id").references(() => routerProvidersTable.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    providerName: text("provider_name"),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("router_requests_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export type RouterProvider = typeof routerProvidersTable.$inferSelect;
export type RouterProviderModel = typeof routerProviderModelsTable.$inferSelect;
export type RouterKey = typeof routerKeysTable.$inferSelect;
export type RouterRequest = typeof routerRequestsTable.$inferSelect;

export const routerProviderStatus = ["connected", "error"] as const;
export const providerKinds = [
  "nvidia",
  "openrouter",
  "deepseek",
  "openai",
  "custom",
] as const;
