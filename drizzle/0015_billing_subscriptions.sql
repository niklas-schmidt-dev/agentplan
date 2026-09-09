ALTER TYPE "public"."user_plan" ADD VALUE 'pro' BEFORE 'unlimited';--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" varchar(32) DEFAULT 'polar' NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"storage_bytes" bigint NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"currency" varchar(8) DEFAULT 'usd' NOT NULL,
	"recurring_interval" varchar(16),
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_period_end_idx" ON "billing_subscriptions" USING btree ("current_period_end");