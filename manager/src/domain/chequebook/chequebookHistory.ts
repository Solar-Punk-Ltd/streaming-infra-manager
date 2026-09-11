import type { ChequebookHistoryQuery } from '@streaming-infra-manager/common';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';
import { operationId } from './operationIdentity.js';

function cursorTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) throw new ChequebookOperationInputError('history cursor');
  const milliseconds = `${value.slice(0, 23)}Z`;
  if (new Date(milliseconds).toISOString() !== milliseconds) throw new ChequebookOperationInputError('history cursor');
  return value;
}

export function historyCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: cursorTime(createdAt), id: operationId(id) })).toString('base64url');
}

export function normalizeHistoryQuery(query: ChequebookHistoryQuery) {
  try {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChequebookOperationInputError('history limit');
    if (query.profileName !== undefined && (typeof query.profileName !== 'string' || !query.profileName.trim() || query.profileName.length > 200)) throw new ChequebookOperationInputError('deployment');
    let after: { createdAt: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string' || query.cursor.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(query.cursor)) throw new ChequebookOperationInputError('history cursor');
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).sort().join(',') !== 'createdAt,id') throw new ChequebookOperationInputError('history cursor');
      after = { createdAt: cursorTime(decoded.createdAt), id: operationId(decoded.id) };
      if (historyCursor(after.createdAt, after.id) !== query.cursor) throw new ChequebookOperationInputError('history cursor');
    }
    return { limit, ...(query.profileName !== undefined ? { profileName: query.profileName } : {}), after };
  } catch { throw new ChequebookOperationInputError('history query'); }
}
