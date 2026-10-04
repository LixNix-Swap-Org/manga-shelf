// the password marker of local profiles: no bcrypt hash, so no password ever matches it
export const LOCAL_PASSWORD_HASH = '!local-profile';
const SERVER_ONLY_SETTINGS = "substr(key, 1, 14) = 'calendar_feed:' OR key IN ('revoked_sessions', 'jwt_secret')";

/**
 * Strips server-only data from an imported database: password hashes become the local marker, API keys, calendar
 * feed tokens, revoked sessions and the signing secret go. `conn` needs prepare(). Returns the changed row count.
 */
export function sanitizeImportedDatabase(conn) {
  const before = Number(Object.values(conn.prepare('PRAGMA secure_delete').get() || {})[0]) || 0;
  // freed and overwritten cells are zeroed, so the old values do not linger in the saved file
  conn.prepare('PRAGMA secure_delete = ON').run();
  try {
    let changed = conn.prepare('UPDATE users SET password_hash = ? WHERE password_hash IS NULL OR password_hash <> ?')
      .run(LOCAL_PASSWORD_HASH, LOCAL_PASSWORD_HASH).changes || 0;
    if (conn.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'user_api_credentials'").get()) {
      changed += conn.prepare('DELETE FROM user_api_credentials').run().changes || 0;
    }
    changed += conn.prepare(`DELETE FROM app_settings WHERE ${SERVER_ONLY_SETTINGS}`).run().changes || 0;
    return changed;
  } finally {
    conn.prepare(`PRAGMA secure_delete = ${before}`).run();
  }
}
