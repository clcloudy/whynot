import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { application } from './routes.mjs';
import { createImageValidator } from './images.mjs';
import { connectPostgres, postgresDb } from './postgres.mjs';

const databaseUrl = Deno.env.get('WHYNOT_DATABASE_URL');
const db = databaseUrl ? postgresDb(connectPostgres(databaseUrl)) : createDatabaseClient();
const validateImage = createImageValidator(() => Deno.readFile(new URL('./magick.wasm', import.meta.url)));
const handle = application({ db, BackendError, env: Deno.env, validateImage });
Deno.serve(async request => {
  let context;
  try { context = createSiteContext(request); return await handle(context); }
  catch (error) {
    const safeError = error instanceof BackendError ? error : new BackendError('STORAGE_UNAVAILABLE', 503);
    return errorResponse(safeError, context?.requestId);
  }
});
