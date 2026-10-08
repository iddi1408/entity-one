-- Staff may hold the owner role; the primary administrator remains the reserved id 'owner'.
-- Rebuild only this table, copying every stored field and recreating its unique index.
CREATE TABLE `__new_staff_users` (
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
	CONSTRAINT "staff_not_owner" CHECK("__new_staff_users"."id" <> 'owner'),
	CONSTRAINT "staff_role" CHECK("__new_staff_users"."role" IN ('owner', 'admin', 'manager', 'editor', 'viewer')),
	CONSTRAINT "staff_permissions_json" CHECK(json_valid("__new_staff_users"."permissions") AND json_type("__new_staff_users"."permissions") = 'array'),
	CONSTRAINT "staff_password_flag" CHECK("__new_staff_users"."must_change_password" IN (0, 1)),
	CONSTRAINT "staff_disabled_flag" CHECK("__new_staff_users"."disabled" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_staff_users`("id", "username", "role", "permissions", "salt", "hash", "hash_version", "must_change_password", "disabled", "created_at", "updated_at", "temp_expires_at") SELECT "id", "username", "role", "permissions", "salt", "hash", "hash_version", "must_change_password", "disabled", "created_at", "updated_at", "temp_expires_at" FROM `staff_users`;--> statement-breakpoint
DROP TABLE `staff_users`;--> statement-breakpoint
ALTER TABLE `__new_staff_users` RENAME TO `staff_users`;--> statement-breakpoint
CREATE UNIQUE INDEX `staff_users_username_unique` ON `staff_users` (`username`);
