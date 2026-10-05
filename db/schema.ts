import {sql} from 'drizzle-orm';
import {sqliteTable, text, integer, index, check} from 'drizzle-orm/sqlite-core';

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
  expires: integer('expires').notNull(), credentialVersion: text('credential_version').notNull()
}, table => [index('idx_sessions_expires').on(table.expires)]);
export const rateLimits = sqliteTable('rate_limits', {
  bucket: text('bucket').primaryKey(), attempts: integer('attempts').notNull(), expires: integer('expires').notNull()
});
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({autoIncrement: true}), at: integer('at').notNull(), action: text('action').notNull(),
  sessionId: text('session_id'), detail: text('detail').notNull()
}, table => [index('idx_audit_at').on(table.at)]);
export const contentBackups = sqliteTable('content_backups', {
  revision: integer('revision').primaryKey(), body: text('body').notNull(),
  createdAt: integer('created_at').notNull(), action: text('action').notNull()
});
