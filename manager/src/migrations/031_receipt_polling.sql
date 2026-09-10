-- One polling budget per submitted transfer, set when the row enters that
-- state and never renewed. Historical rows keep NULL, which is that rule
-- applied to the past: nothing the manager never started polling begins now.
ALTER TABLE chequebook_operations
  ADD COLUMN receipt_poll_until TIMESTAMPTZ
  CHECK (receipt_poll_until IS NULL OR transaction_hash IS NOT NULL);

CREATE INDEX chequebook_operations_awaiting_receipt
  ON chequebook_operations (receipt_checked_at NULLS FIRST, created_at)
  WHERE state = 'submitted' AND receipt_poll_until IS NOT NULL;
