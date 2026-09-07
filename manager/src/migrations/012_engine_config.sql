-- A config file of the operator's own for the deployment's media engine, and
-- what happened the last time one was applied.
--
-- engine_config holds the whole file as text, placeholders and all, or NULL for
-- "render the template", which is what every deployment did before this column
-- existed. The stack fills the placeholders at container start, so the
-- passphrase, the ports and the webhook token are never in this text. It is
-- read on its own rather than with every row: a file runs to tens of
-- kilobytes, and a row travels to the browser and over the event stream, where
-- only whether there is one matters.
--
-- engine_config_error is why the last apply was reverted, with the engine's
-- last log lines, or NULL. The next apply that holds clears it.
ALTER TABLE profiles ADD COLUMN engine_config TEXT;
ALTER TABLE profiles ADD COLUMN engine_config_error TEXT;
