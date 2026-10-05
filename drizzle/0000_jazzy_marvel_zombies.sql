CREATE TABLE `administrator` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`salt` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_content` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires`);