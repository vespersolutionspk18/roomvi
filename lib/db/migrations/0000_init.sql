CREATE TYPE "public"."bond" AS ENUM('stack', 'running', 'herringbone', 'basketweave');--> statement-breakpoint
CREATE TYPE "public"."executor" AS ENUM('precision', 'generative');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('analyze', 'render', 'mipmap');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."material_category" AS ENUM('flooring', 'tile', 'stone', 'wood', 'rug', 'countertop', 'wallpaper', 'paint', 'cabinetry');--> statement-breakpoint
CREATE TYPE "public"."op_kind" AS ENUM('material', 'prompt');--> statement-breakpoint
CREATE TYPE "public"."render_status" AS ENUM('queued', 'running', 'ready', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."surface_kind" AS ENUM('floor', 'wall', 'ceiling', 'countertop', 'backsplash', 'upper_cabinets', 'lower_cabinets', 'island', 'window', 'door', 'rug', 'furniture', 'appliance', 'custom');--> statement-breakpoint
CREATE TYPE "public"."surface_source" AS ENUM('fal', 'brush', 'derived');--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"user_id" varchar(21) NOT NULL,
	"delta" integer NOT NULL,
	"reason" varchar(80) NOT NULL,
	"render_id" varchar(21),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"user_id" varchar(21) NOT NULL,
	"material_id" varchar(21) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"project_id" varchar(21) NOT NULL,
	"storage_key" text NOT NULL,
	"display_key" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"exif" jsonb,
	"quality" jsonb,
	"fal_url" text,
	"fal_url_expires_at" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"kind" "job_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(80),
	"lease_expires_at" timestamp with time zone,
	"idempotency_key" varchar(200),
	"last_error" text,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"sku" varchar(80) NOT NULL,
	"supplier_id" varchar(21),
	"category" "material_category" NOT NULL,
	"name" varchar(200) NOT NULL,
	"texture_key" text,
	"hero_key" text,
	"mip_levels" smallint,
	"tile_w_mm" integer,
	"tile_h_mm" integer,
	"grout_mm" real DEFAULT 3,
	"bond" "bond" DEFAULT 'stack' NOT NULL,
	"finish" varchar(80),
	"color_lab" jsonb,
	"lead_time_days" integer,
	"precision_ready" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"user_id" varchar(21) NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_ops" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"render_id" varchar(21) NOT NULL,
	"seq" smallint NOT NULL,
	"kind" "op_kind" NOT NULL,
	"surface_id" varchar(21),
	"material_id" varchar(21),
	"prompt" text,
	"params" jsonb
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"project_id" varchar(21) NOT NULL,
	"base_image_id" varchar(21) NOT NULL,
	"status" "render_status" DEFAULT 'queued' NOT NULL,
	"executor" "executor" NOT NULL,
	"output_key" text,
	"width" integer,
	"height" integer,
	"model" varchar(120),
	"seed" integer,
	"cost_units" real,
	"fal_request_id" varchar(120),
	"drift_score" real,
	"error_code" varchar(80),
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"token" varchar(32) NOT NULL,
	"render_id" varchar(21) NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"website" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surfaces" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"image_id" varchar(21) NOT NULL,
	"kind" "surface_kind" NOT NULL,
	"label" varchar(120) NOT NULL,
	"mask_key" text NOT NULL,
	"bbox" jsonb,
	"confidence" real,
	"source" "surface_source" DEFAULT 'fal' NOT NULL,
	"area_m2_low" real,
	"area_m2_high" real,
	"plane" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(120),
	"credits" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_ops" ADD CONSTRAINT "render_ops_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_ops" ADD CONSTRAINT "render_ops_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_ops" ADD CONSTRAINT "render_ops_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_base_image_id_images_id_fk" FOREIGN KEY ("base_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_unique_idx" ON "favorites" USING btree ("user_id","material_id");--> statement-breakpoint
CREATE INDEX "images_project_idx" ON "images" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "images_sha_idx" ON "images" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "materials_category_idx" ON "materials" USING btree ("category");--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "render_ops_seq_idx" ON "render_ops" USING btree ("render_id","seq");--> statement-breakpoint
CREATE INDEX "renders_project_idx" ON "renders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "renders_base_image_idx" ON "renders" USING btree ("base_image_id");--> statement-breakpoint
CREATE INDEX "share_links_render_idx" ON "share_links" USING btree ("render_id");--> statement-breakpoint
CREATE INDEX "surfaces_image_idx" ON "surfaces" USING btree ("image_id");