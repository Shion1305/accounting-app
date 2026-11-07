CREATE TABLE `accounting_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`circle_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`expires_at` integer NOT NULL,
	`period_from` text DEFAULT '' NOT NULL,
	`period_to` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`response_id` text,
	`input_ids` text DEFAULT '[]' NOT NULL,
	`container_ids` text DEFAULT '[]' NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`error` text,
	`usage` text,
	`cleaned_at` integer,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounting_exports_circle_idx` ON `accounting_exports` (`circle_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `accounting_exports_cleanup_idx` ON `accounting_exports` (`cleaned_at`,`expires_at`);