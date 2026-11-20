import postgres from 'postgres';
import { createPostgresDb } from './database.mjs';

export function postgresDb(client) {
  return createPostgresDb(
    (sql, params) => client.unsafe(sql, params),
    work => client.begin(transaction => work((sql, params) => transaction.unsafe(sql, params))),
  );
}

export function connectPostgres(url) {
  return postgres(url, {
    max: 4,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 20,
    onnotice: () => {},
    connection: {
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 7000,
    },
  });
}
