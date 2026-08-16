/**
 * Decides whether two Postgres connection strings point at the same physical database, for
 * `postgres-store.test.ts`'s guard against running its destructive `TRUNCATE`-before-every-test
 * suite against a real dev/prod database.
 *
 * Factored out of postgres-store.test.ts (rather than inlined there like the rest of that
 * file's guard logic) purely so this comparison is independently unit testable without pulling
 * in that file's side effects (throwing at module scope, creating a real DB pool, running
 * migrations).
 *
 * A plain `===` on the two raw strings is not enough. Two connection strings can be
 * byte-different and still address the *same* database:
 *   - Neon (this project's Postgres host) hands out both a pooled hostname
 *     (`ep-xxx-pooler.<region>.aws.neon.tech`) and a direct hostname
 *     (`ep-xxx.<region>.aws.neon.tech`) for the same database — `DATABASE_URL` on one and
 *     `COMPANION_TEST_DATABASE_URL` on the other would pass a byte comparison and still let
 *     the TRUNCATE below hit real data.
 *   - Differing query parameters (`?sslmode=require` vs `?sslmode=require&channel_binding=require`),
 *     differing credentials for the same role, or a trailing slash all produce byte-different
 *     strings for the same target.
 * None of those differences change which database actually receives queries, so this compares
 * the parsed (host-with-pooler-suffix-normalized, database-name) pair instead — the only two
 * parts of the string that do.
 */

interface ConnectionTarget {
  host: string;
  database: string;
}

/** Neon's pooled endpoint adds this suffix to the first label of its direct endpoint's
 * hostname; stripping it is what lets a pooled/direct pair for the same database compare equal.
 * A hostname that isn't a Neon endpoint at all just never has this suffix, so stripping it is a
 * no-op — safe to apply unconditionally rather than needing to detect "is this a Neon host". */
const POOLER_SUFFIX = '-pooler';

function normalizeConnectionTarget(connectionString: string): ConnectionTarget | undefined {
  let url: URL;
  try {
    // Postgres connection strings are valid WHATWG URLs (scheme postgres:// or postgresql://);
    // the URL parser handles them the same as any other scheme.
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  const labels = url.hostname.toLowerCase().split('.');
  const [firstLabel, ...restLabels] = labels;
  const normalizedFirstLabel = firstLabel.endsWith(POOLER_SUFFIX)
    ? firstLabel.slice(0, -POOLER_SUFFIX.length)
    : firstLabel;
  const host = [normalizedFirstLabel, ...restLabels].join('.');
  // pathname is "/<database>" (or "/" with no database) — credentials (url.username/password)
  // and query params (url.search) are deliberately never compared: neither changes which
  // database a query lands in. Strip both a leading and a trailing slash so
  // "/companion" and "/companion/" normalize to the same database name.
  const database = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return { host, database };
}

/**
 * True if `a` and `b` are byte-identical, OR both parse as connection strings whose normalized
 * (pooler-stripped host, database name) pair matches. False if either fails to parse as a URL
 * and they aren't byte-identical — an unparsable connection string can't be proven to match
 * anything, and the caller's guard must fail closed (refuse to run) rather than assume safety,
 * so "false" here is the conservative answer only in the sense of not short-circuiting a
 * same-database finding; the caller separately requires both variables to be set and valid
 * before ever reaching this comparison.
 */
export function pointsAtSameDatabase(a: string, b: string): boolean {
  if (a === b) return true;
  const targetA = normalizeConnectionTarget(a);
  const targetB = normalizeConnectionTarget(b);
  if (!targetA || !targetB) return false;
  return targetA.host === targetB.host && targetA.database === targetB.database;
}
