import { DatabaseSync } from "node:sqlite";
import type { D1Like } from "agentic-identity/cloudflare";

/** A D1 stand-in on node:sqlite, for tests only. It reports no region, so a store on it needs the "unknown" region. */
export function sqliteD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  const statement = (sql: string, values: unknown[] = []) => {
    const self = {
      sql,
      values,
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (db.prepare(sql).get(...(values as never[])) as never) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...(values as never[])) as never[] }),
      run: async () => db.prepare(sql).run(...(values as never[])),
    };
    return self;
  };
  return {
    prepare: (sql: string) => statement(sql) as never,
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of statements as unknown as ReturnType<typeof statement>[]) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
