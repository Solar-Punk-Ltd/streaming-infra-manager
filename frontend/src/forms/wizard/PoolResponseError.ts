export const POOL_RESPONSE_NOTICE = 'The manager accepted the request, but we could not select a matching storage pool from its response. Your uploader draft is unchanged. Check the pool before trying again.';

export class PoolResponseError extends Error {
  constructor() {
    super(POOL_RESPONSE_NOTICE);
    this.name = 'PoolResponseError';
  }
}
