import { sql, type SQL } from "drizzle-orm";

const CANONICAL_UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Preserve uuid::text equality while allowing the UUID column's index to be used.
 * PostgreSQL also accepts uppercase, braces, and other noncanonical UUID inputs.
 * Those did not match the previous text comparison and must remain unmatched.
 * Invalid stored references return null rather than aborting a background sweep.
 */
export function canonicalUuidTextReference(value: SQL): SQL<string | null> {
  return sql<string | null>`case
    when length(${value}) = 36 and (${value}) ~ ${CANONICAL_UUID}
    then (${value})::uuid
    else null
  end`;
}
