export function rewritePlaceholders(sql) {
  let index = 0
  let output = ''
  let quote = null

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    const next = sql[i + 1]

    if (quote) {
      output += char
      if (char === quote) {
        if (next === quote) {
          output += next
          i += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      output += char
      continue
    }

    if (char === '-' && next === '-') {
      const lineEnd = sql.indexOf('\n', i)
      if (lineEnd === -1) return output + sql.slice(i)
      output += sql.slice(i, lineEnd + 1)
      i = lineEnd
      continue
    }

    if (char === '?') {
      index += 1
      output += `$${index}`
      continue
    }

    output += char
  }

  return output
}

export function transformSqliteDdl(sql) {
  let transformed = sql
    .replace(/^\s*PRAGMA\b[^;]*;?/gim, '')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/\bBLOB\b/gi, 'BYTEA')
    .replace(/\(datetime\('now'\)\)/gi, '(NOW()::text)')
    .replace(/\bdatetime\('now'\)/gi, 'NOW()::text')
    .replace(/\(unixepoch\(\)\)/gi, '(EXTRACT(EPOCH FROM NOW())::BIGINT)')

  transformed = transformed.replace(
    /CREATE TRIGGER IF NOT EXISTS audit_log_no_update[\s\S]*?END;/gi,
    () => `CREATE OR REPLACE FUNCTION prevent_audit_log_update()
RETURNS trigger LANGUAGE plpgsql AS $fn_no_update$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: UPDATE not permitted';
END;
$fn_no_update$;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_update();`
  )

  transformed = transformed.replace(
    /CREATE TRIGGER IF NOT EXISTS audit_log_no_delete[\s\S]*?END;/gi,
    () => `CREATE OR REPLACE FUNCTION prevent_audit_log_delete()
RETURNS trigger LANGUAGE plpgsql AS $fn_no_delete$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: DELETE not permitted';
END;
$fn_no_delete$;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_delete();`
  )

  return transformed
}
