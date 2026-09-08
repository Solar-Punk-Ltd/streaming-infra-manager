CREATE TABLE chequebook_operations (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE,
  profile_name TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  amount_plur TEXT NOT NULL CHECK (amount_plur ~ '^[1-9][0-9]{0,29}$'),
  chain_id BIGINT NOT NULL CHECK (chain_id BETWEEN 1 AND 9007199254740991),
  node_address TEXT NOT NULL CHECK (node_address ~ '^0x[0-9a-f]{40}$'),
  chequebook_address TEXT NOT NULL CHECK (chequebook_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  start_block_number NUMERIC(78, 0) NOT NULL CHECK (start_block_number >= 0),
  start_block_hash TEXT NOT NULL CHECK (start_block_hash ~ '^0x[0-9a-f]{64}$'),
  nonce_lower_bound NUMERIC(78, 0) NOT NULL CHECK (nonce_lower_bound >= 0),
  nonce_query_tag TEXT NOT NULL CHECK (nonce_query_tag ~ '^(latest|pending|safe|finalized|0x(0|[1-9a-f][0-9a-f]*))$'),
  state TEXT NOT NULL DEFAULT 'submitting' CHECK (state IN ('submitting', 'submitted', 'unknown', 'settled', 'reverted', 'asserted', 'rejected')),
  transaction_hash TEXT CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  failure_reason TEXT CHECK (failure_reason IN ('preflight_failed', 'response_unavailable', 'invalid_response', 'hash_conflict')),
  dispatch_started_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  receipt_observation JSONB,
  receipt_checked_at TIMESTAMPTZ,
  recovery_observation JSONB,
  recovery_checked_at TIMESTAMPTZ,
  assertion JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state NOT IN ('submitted', 'settled', 'reverted') OR transaction_hash IS NOT NULL),
  CHECK (state NOT IN ('submitting', 'unknown', 'rejected') OR transaction_hash IS NULL),
  CHECK ((receipt_observation IS NULL) = (receipt_checked_at IS NULL)),
  CHECK (receipt_observation IS NULL OR jsonb_typeof(receipt_observation) = 'object')
);

-- History outlives a deployment and remains available for late request retries.
CREATE INDEX chequebook_operations_profile ON chequebook_operations (profile_name, created_at DESC);
CREATE UNIQUE INDEX chequebook_operations_open_node ON chequebook_operations (chain_id, node_address)
  WHERE state IN ('submitting', 'submitted', 'unknown');

CREATE UNIQUE INDEX chequebook_operations_transaction_owner ON chequebook_operations (chain_id, transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE TABLE chequebook_submission_responses (
  operation_id UUID NOT NULL REFERENCES chequebook_operations(id),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ownership TEXT NOT NULL CHECK (ownership IN ('owned', 'conflict')),
  PRIMARY KEY (operation_id, transaction_hash)
);
