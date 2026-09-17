-- How much of a chain a deployment's Bee node runs with, and where that node's
-- chain endpoint comes from. Levi ruled on 2026-09-17 that both are chosen when
-- the node is created (T27).
--
-- A light node has a chequebook, gas and postage, so it can publish. An
-- ultra-light node has no chain at all and can only retrieve. Until now the
-- stack decided that per service, in its compose file, so no deployment could
-- say anything about it.
--
-- NULL node_mode means "as the stack ships that node": light for a profile that
-- owns a bee-uploader, ultra-light for one whose node is a bee-gateway. Nothing
-- is backfilled, so an existing deployment reads exactly as it behaves without
-- a data fix.
ALTER TABLE profiles
  ADD COLUMN node_mode TEXT
  CHECK (node_mode IS NULL OR node_mode IN ('light', 'ultra-light'));

-- 'stack' is what every stored row does today: the deployment's env file
-- carries no RPC_ENDPOINT line and the stack's compose default applies.
-- 'manager' is the endpoint this manager is configured with, and 'custom' is
-- the address the deployment stores in rpc_endpoint, which 032 added.
ALTER TABLE profiles
  ADD COLUMN rpc_endpoint_source TEXT NOT NULL DEFAULT 'stack'
  CHECK (rpc_endpoint_source IN ('manager', 'stack', 'custom'));

-- A deployment that already names an address has always used it, so it is a
-- custom one and saying otherwise would change where it reaches the chain on
-- its next deploy.
UPDATE profiles
   SET rpc_endpoint_source = 'custom'
 WHERE rpc_endpoint IS NOT NULL;

-- The source and the stored address go together and only together. Without the
-- second direction a row could say it takes the manager's endpoint while
-- carrying an address of its own, and nothing anywhere would say which of the
-- two the deploy wrote. Validated rather than NOT VALID, unlike 033 and 034,
-- because the UPDATE above leaves every stored row inside the rule.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_rpc_endpoint_source_pairing
  CHECK ((rpc_endpoint_source = 'custom') = (rpc_endpoint IS NOT NULL));
