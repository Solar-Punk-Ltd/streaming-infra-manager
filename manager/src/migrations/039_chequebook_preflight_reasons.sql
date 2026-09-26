-- A transfer the last check before sending refused now says why when the node
-- could not pay for it: no xDAI for gas, or less BZZ than the amount asked. Any
-- other preflight refusal, and every row written before this, keeps
-- 'preflight_failed', so nothing is backfilled.
--
-- Numbered 039 because the deployment settings branches open at the time of
-- writing take 036 to 038. The runner applies any file it has not seen, in name
-- order, so the gap changes nothing.
ALTER TABLE chequebook_operations DROP CONSTRAINT chequebook_operations_failure_reason_check;
ALTER TABLE chequebook_operations ADD CONSTRAINT chequebook_operations_failure_reason_check
  CHECK (failure_reason IN ('preflight_failed', 'preflight_no_gas', 'preflight_insufficient_balance',
    'response_unavailable', 'invalid_response', 'hash_conflict'));
