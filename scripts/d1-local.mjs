import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';

export function localDB(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename), executions = new WeakMap();
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  for (const name of readdirSync('drizzle').filter(value => value.endsWith('.sql')).sort()) {
    if (!sqlite.prepare('SELECT name FROM local_migrations WHERE name = ?').get(name)) {
      sqlite.exec(readFileSync('drizzle/' + name, 'utf8'));
      sqlite.prepare('INSERT INTO local_migrations (name) VALUES (?)').run(name);
    }
  }
  return {
    prepare(sql) {
      let args = [];
      const execute = () => {
        const result = sqlite.prepare(sql).run(...args);
        return {success: true, meta: {changes: Number(result.changes)}};
      };
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return {results: sqlite.prepare(sql).all(...args)}; },
        async run() { return execute(); }
      };
      executions.set(statement, execute);
      return statement;
    },
    async batch(statements) {
      // DatabaseSync operations must not yield while this connection owns a transaction.
      // Awaiting statement.run() here would let other requests enter the same transaction.
      const operations = statements.map(statement => {
        const execute = executions.get(statement);
        if (!execute) throw new TypeError('Batch statements must belong to this database.');
        return execute;
      });
      sqlite.exec('BEGIN');
      try {
        const results = operations.map(execute => execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
}
