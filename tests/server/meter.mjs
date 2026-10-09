// Count executed SQL statements, including each statement in a D1 batch.
export function metered(db, metrics) {
  const originals = new WeakMap();
  function result(r) {
    for (const item of Array.isArray(r) ? r : [r]) {
      metrics.rowsRead += item?.meta?.rows_read ?? 0;
      metrics.rowsWritten += item?.meta?.rows_written ?? 0;
    }
    return r;
  }
  function count(n) {
    metrics.queries += n;
    if (metrics.queries > 50)
      throw Error("D1 Free query budget exceeded: " + metrics.queries);
  }
  function wrap(s) {
    const wrapped = {
      bind(...values) {
        return wrap(s.bind(...values));
      },
    };
    for (const method of ["first", "all", "raw", "run"])
      wrapped[method] = async (...args) => {
        count(1);
        return result(await s[method](...args));
      };
    originals.set(wrapped, s);
    return wrapped;
  }
  return {
    prepare(sql) {
      return wrap(db.prepare(sql));
    },
    async batch(statements) {
      count(statements.length);
      return result(
        await db.batch(statements.map((s) => originals.get(s) ?? s)),
      );
    },
  };
}
export const counters = () => ({ queries: 0, rowsRead: 0, rowsWritten: 0 });
