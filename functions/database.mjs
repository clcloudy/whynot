// The application schema stays fixed. Values always travel as SQL parameters.
function identifier(name) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid database identifier');
  return `"${name}"`;
}

export function createPostgresDb(query, begin) {
  function from(table) {
    const target = `app.${identifier(table)}`;
    const filters = [], sorts = [], params = [];
    let columns = '*', operation = 'select', values, conflict, limit;
    const bind = value => {
      params.push(value);
      return `$${params.length}`;
    };
    const projection = names => names.split(',').map(identifier).join(', ');
    const filter = (name, operator, value) => {
      filters.push(`${identifier(name)} ${operator} ${bind(value)}`);
      return builder;
    };
    const builder = {
      select(names) { columns = projection(names); return builder; },
      eq(name, value) { return filter(name, '=', value); },
      gt(name, value) { return filter(name, '>', value); },
      lt(name, value) { return filter(name, '<', value); },
      order(name, { ascending = true } = {}) {
        sorts.push(`${identifier(name)} ${ascending ? 'ASC' : 'DESC'}`);
        return builder;
      },
      limit(count) { limit = count; return builder; },
      insert(row) { operation = 'insert'; values = row; return builder; },
      insertIfAbsent(row, options) {
        conflict = projection(options.onConflict);
        return builder.insert(row);
      },
      update(row) { operation = 'update'; values = row; return builder; },
      delete() { operation = 'delete'; return builder; },
      then(resolve, reject) {
        const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
        let sql;
        if (operation === 'select') {
          sql = `SELECT ${columns} FROM ${target}${where}`;
          if (sorts.length) sql += ` ORDER BY ${sorts.join(', ')}`;
          if (limit !== undefined) sql += ` LIMIT ${bind(limit)}`;
        } else if (operation === 'insert') {
          const keys = projection(Object.keys(values).join(','));
          sql = `INSERT INTO ${target} (${keys}) VALUES (${Object.values(values).map(bind).join(', ')})`;
          if (conflict) sql += ` ON CONFLICT (${conflict}) DO NOTHING`;
        } else if (operation === 'update') {
          const assignments = Object.entries(values).map(([key, value]) => `${identifier(key)} = ${bind(value)}`);
          sql = `UPDATE ${target} SET ${assignments.join(', ')}${where}`;
        } else {
          sql = `DELETE FROM ${target}${where}`;
        }
        if (operation !== 'select') sql += ` RETURNING ${columns}`;
        return query(sql, params).then(data => resolve({ data }), reject);
      },
    };
    return builder;
  }

  return {
    from,
    async transaction(owner, work) {
      return begin(async execute => {
        await execute('SELECT owner FROM app.sessions WHERE owner = $1 FOR UPDATE', [owner]);
        return work(createPostgresDb(execute));
      });
    },
    recentTurns(owner, id, at) {
      return query(`
        SELECT t.user_text, t.reply_text,
          COALESCE(jsonb_agg(jsonb_build_object('memory_id', d.memory_id, 'version', d.version))
            FILTER (WHERE d.memory_id IS NOT NULL), '[]') AS dependencies
        FROM app.turns t LEFT JOIN app.turn_memories d ON d.turn_id = t.id
        WHERE t.owner = $1 AND t.interaction_id = $2 AND t.reply_text <> ''
          AND NOT EXISTS (
            SELECT 1 FROM app.turn_memories linked
            WHERE linked.turn_id = t.id AND NOT EXISTS (
              SELECT 1 FROM app.memories m WHERE m.id = linked.memory_id AND m.owner = t.owner
                AND m.version = linked.version AND m.expires_at > $3
            )
          )
        GROUP BY t.id ORDER BY t.version DESC LIMIT 3`, [owner, id, at]);
    },
    invalidateMemoryTurns(owner, at) {
      return query('SELECT app.redact_invalid_memory_turns($1, $2)', [owner, at]);
    },
    clearInteraction(owner, id, state) {
      return query('SELECT app.clear_interaction($1, $2, $3)', [owner, id, state]);
    },
    purgeExpired(at) {
      return query('SELECT app.purge_expired($1)', [at]);
    },
  };
}
