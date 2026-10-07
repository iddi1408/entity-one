import {sql} from 'drizzle-orm';
import {sqliteTable, text, integer, index, check, customType} from 'drizzle-orm/sqlite-core';

const caseInsensitiveText = customType<{data: string}>({dataType: () => 'text COLLATE NOCASE'});

export const content = sqliteTable('site_content', {
  id: text('id').primaryKey(), body: text('body').notNull(), revision: integer('revision').notNull().default(1)
});
export const administrator = sqliteTable('administrator', {
  id: integer('id').primaryKey(), username: text('username').notNull(), salt: text('salt').notNull(), hash: text('hash').notNull(),
  hashVersion: text('hash_version').notNull().default('legacy-disabled')
}, table => [check('single_administrator', sql`${table.id} = 1`)]);
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), sessionId: text('session_id').notNull().unique(),
  createdAt: integer('created_at').notNull(), lastSeen: integer('last_seen').notNull(),
  expires: integer('expires').notNull(), credentialVersion: text('credential_version').notNull(),
  userId: text('user_id').notNull().default('owner')
}, table => [index('idx_sessions_expires').on(table.expires), index('idx_sessions_user').on(table.userId)]);
export const staffUsers = sqliteTable('staff_users', {
  id: text('id').primaryKey(), username: caseInsensitiveText('username').notNull().unique(),
  role: text('role').notNull(), permissions: text('permissions').notNull(),
  salt: text('salt').notNull(), hash: text('hash').notNull(), hashVersion: text('hash_version').notNull(),
  mustChangePassword: integer('must_change_password').notNull().default(1), disabled: integer('disabled').notNull().default(0),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(), tempExpiresAt: integer('temp_expires_at')
}, table => [
  check('staff_not_owner', sql`${table.id} <> 'owner'`),
  check('staff_role', sql`${table.role} IN ('admin', 'manager', 'editor', 'viewer')`),
  check('staff_permissions_json', sql`json_valid(${table.permissions}) AND json_type(${table.permissions}) = 'array'`),
  check('staff_password_flag', sql`${table.mustChangePassword} IN (0, 1)`),
  check('staff_disabled_flag', sql`${table.disabled} IN (0, 1)`)
]);
export const rateLimits = sqliteTable('rate_limits', {
  bucket: text('bucket').primaryKey(), attempts: integer('attempts').notNull(), expires: integer('expires').notNull()
});
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({autoIncrement: true}), at: integer('at').notNull(), action: text('action').notNull(),
  sessionId: text('session_id'), detail: text('detail').notNull(),
  actorId: text('actor_id'), actorUsername: text('actor_username'), actorRole: text('actor_role')
}, table => [index('idx_audit_at').on(table.at)]);
export const auditDelivery = sqliteTable('audit_delivery', {
  auditId: integer('audit_id').primaryKey(), attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0), sentAt: integer('sent_at'),
  lastError: text('last_error'), leaseUntil: integer('lease_until').notNull().default(0)
}, table => [index('idx_audit_delivery_due').on(table.sentAt, table.nextAttemptAt, table.leaseUntil)]);
export const contentBackups = sqliteTable('content_backups', {
  revision: integer('revision').primaryKey(), body: text('body').notNull(),
  createdAt: integer('created_at').notNull(), action: text('action').notNull()
});

export const analyticsEvents = sqliteTable('analytics_events', {
  id: text('id').primaryKey(), visitId: text('visit_id').notNull(), at: integer('at').notNull(), day: text('day').notNull(),
  type: text('type').notNull(), path: text('path').notNull(), target: text('target').notNull(),
  country: text('country').notNull(), device: text('device').notNull(), browser: text('browser').notNull(), source: text('source').notNull(),
  carLabel: text('car_label').notNull().default(''), carBrand: text('car_brand').notNull().default(''),
  carRegion: text('car_region').notNull().default(''), carType: text('car_type').notNull().default('')
}, table => [
  index('idx_analytics_at').on(table.at), index('idx_analytics_country_at').on(table.country, table.at),
  index('idx_analytics_device_at').on(table.device, table.at), index('idx_analytics_visit').on(table.visitId, table.type, table.at),
  check('analytics_event_type', sql`${table.type} IN ('page_view','click','car_view','region_click','brand_click','enquiry')`),
  check('analytics_public_path', sql`${table.path} IN ('/','/inventory','/wanted','/about','/contact')`),
  check('analytics_device', sql`${table.device} IN ('desktop','mobile','tablet','unknown')`)
]);
export const analyticsRateLimits = sqliteTable('analytics_rate_limits', {
  bucket: text('bucket').primaryKey(), eventCount: integer('event_count').notNull(), expires: integer('expires').notNull()
}, table => [index('idx_analytics_rate_expiry').on(table.expires)]);
export const analyticsMetadata = sqliteTable('analytics_metadata', {
  id: text('id').primaryKey(), startedAt: integer('started_at').notNull()
}, table => [check('analytics_metadata_singleton', sql`${table.id} = 'main'`)]);
export const chatRateLimits = sqliteTable('chat_rate_limits', {
  bucket: text('bucket').primaryKey(), attempts: integer('attempts').notNull(), expires: integer('expires').notNull()
}, table => [index('idx_chat_rate_expiry').on(table.expires)]);
