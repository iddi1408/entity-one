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
