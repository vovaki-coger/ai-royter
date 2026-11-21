CREATE TABLE "router_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(80) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "router_provider_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"context_length" integer,
	"input_modalities" text[],
	"supports_vision" boolean,
	"unavailable_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "router_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"provider_slug" varchar(63),
	"name" varchar(80) NOT NULL,
	"api_protocol" varchar(40) DEFAULT 'openai_chat_completions' NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"key_hint" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "router_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"provider_id" uuid,
	"model" text NOT NULL,
	"provider_name" text,
	"status" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "router_provider_models" ADD CONSTRAINT "router_provider_models_provider_id_router_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."router_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "router_requests" ADD CONSTRAINT "router_requests_provider_id_router_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."router_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "router_keys_user_idx" ON "router_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "router_provider_model_unique" ON "router_provider_models" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "router_provider_models_user_idx" ON "router_provider_models" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "router_providers_user_idx" ON "router_providers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "router_providers_user_provider_slug_unique" ON "router_providers" USING btree ("user_id","provider_slug");--> statement-breakpoint
CREATE INDEX "router_requests_user_created_idx" ON "router_requests" USING btree ("user_id","created_at");