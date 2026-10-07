CREATE TABLE `chat_rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_rate_expiry` ON `chat_rate_limits` (`expires`);