CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`visit_id` text NOT NULL,
	`at` integer NOT NULL,
	`day` text NOT NULL,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`target` text NOT NULL,
	`country` text NOT NULL,
	`device` text NOT NULL,
	`browser` text NOT NULL,
	`source` text NOT NULL,
	`car_label` text DEFAULT '' NOT NULL,
	`car_brand` text DEFAULT '' NOT NULL,
	`car_region` text DEFAULT '' NOT NULL,
	`car_type` text DEFAULT '' NOT NULL,
	CONSTRAINT "analytics_event_type" CHECK("analytics_events"."type" IN ('page_view','click','car_view','region_click','brand_click','enquiry')),
	CONSTRAINT "analytics_public_path" CHECK("analytics_events"."path" IN ('/','/inventory','/wanted','/about','/contact')),
	CONSTRAINT "analytics_device" CHECK("analytics_events"."device" IN ('desktop','mobile','tablet','unknown'))
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_at` ON `analytics_events` (`at`);--> statement-breakpoint
CREATE INDEX `idx_analytics_country_at` ON `analytics_events` (`country`,`at`);--> statement-breakpoint
CREATE INDEX `idx_analytics_device_at` ON `analytics_events` (`device`,`at`);--> statement-breakpoint
CREATE INDEX `idx_analytics_visit` ON `analytics_events` (`visit_id`,`type`,`at`);--> statement-breakpoint
CREATE TABLE `analytics_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	CONSTRAINT "analytics_metadata_singleton" CHECK("analytics_metadata"."id" = 'main')
);
--> statement-breakpoint
CREATE TABLE `analytics_rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`event_count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_rate_expiry` ON `analytics_rate_limits` (`expires`);