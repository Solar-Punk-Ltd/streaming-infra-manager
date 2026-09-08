const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new Error('Invalid saved transfer history query'); };

/** The offline fixture uses its own opaque cursor over millisecond timestamps and immutable IDs. */
export function mockChequebookHistory(operations, rawUrl) {
  const params = new URL(rawUrl, 'http://localhost').searchParams;
  if ([...params.keys()].some(key => !['limit', 'cursor', 'profileName'].includes(key) || params.getAll(key).length !== 1)) invalid();
  const rawLimit = params.get('limit') ?? '50';
  if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) invalid();
  const limit = Number(rawLimit);
  const profileName = params.get('profileName');
  if (profileName !== null && (!profileName.trim() || profileName.length > 200)) invalid();
  let after = null;
  if (params.has('cursor')) {
    const cursor = params.get('cursor');
    if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
    try {
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!after || typeof after !== 'object' || Array.isArray(after) || Object.keys(after).sort().join(',') !== 'createdAt,id' ||
          typeof after.id !== 'string' || !UUID.test(after.id) || typeof after.createdAt !== 'string' ||
          new Date(after.createdAt).toISOString() !== after.createdAt) invalid();
    } catch { invalid(); }
  }
  const rows = operations.filter(operation => profileName === null || operation.profileName === profileName)
    .filter(operation => after === null || operation.createdAt < after.createdAt || (operation.createdAt === after.createdAt && operation.id < after.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return structuredClone({ operations: page, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : null });
}
