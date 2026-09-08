-- Historical journal rows have no proven deployment instance. Never infer one by name.
-- No foreign key: saved transfers outlive removal of the deployment that submitted them.
ALTER TABLE chequebook_operations ADD COLUMN profile_instance_id UUID;
