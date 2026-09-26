-- A container record is the environment the manager worked out one service's
-- container was started with. Until now it kept the deployment's stream key and
-- SRT passphrase in clear beside the ports, because the snapshot wrote every key
-- the service reads. No page reads the column, so nothing ever showed them, but
-- every copy of this database carried them a second time. The snapshot now
-- leaves every secret-shaped key out, and this takes them out of the rows
-- written before it.
--
-- Secret-shaped is the rule the settings page masks by, `isSecretSettingKey` in
-- common/src/stackSettings.ts: a name ending in _TOKEN, _SECRET, _PASSPHRASE,
-- _PASSWORD or _KEY, which covers every name that function also lists by name.
--
-- Nothing that reads the column loses anything, and going back to an older
-- manager needs no step: it writes the keys again on its next deploy.
UPDATE containers
   SET env = (
         SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
           FROM jsonb_each(containers.env) AS entry
          WHERE entry.key !~ '_(TOKEN|SECRET|PASSPHRASE|PASSWORD|KEY)$'
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_object_keys(containers.env) AS recorded(key)
          WHERE recorded.key ~ '_(TOKEN|SECRET|PASSPHRASE|PASSWORD|KEY)$'
       );
