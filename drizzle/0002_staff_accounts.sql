CREATE TABLE `audit_delivery` (
	`audit_id` integer PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`last_error` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_delivery_due` ON `audit_delivery` (`sent_at`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `staff_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text COLLATE NOCASE NOT NULL,
	`role` text NOT NULL,
	`permissions` text NOT NULL,
	`salt` text NOT NULL,
	`hash` text NOT NULL,
	`hash_version` text NOT NULL,
	`must_change_password` integer DEFAULT 1 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`temp_expires_at` integer,
	CONSTRAINT "staff_not_owner" CHECK("staff_users"."id" <> 'owner'),
	CONSTRAINT "staff_role" CHECK("staff_users"."role" IN ('admin', 'manager', 'editor', 'viewer')),
	CONSTRAINT "staff_permissions_json" CHECK(json_valid("staff_users"."permissions") AND json_type("staff_users"."permissions") = 'array'),
	CONSTRAINT "staff_password_flag" CHECK("staff_users"."must_change_password" IN (0, 1)),
	CONSTRAINT "staff_disabled_flag" CHECK("staff_users"."disabled" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_users_username_unique` ON `staff_users` (`username`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `actor_username` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `actor_role` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);
--> statement-breakpoint
-- Only new events are queued; existing audit history is deliberately not enqueued.
CREATE TRIGGER audit_log_enqueue AFTER INSERT ON audit_log
BEGIN
  INSERT INTO audit_delivery (audit_id) VALUES (NEW.id);
END;
