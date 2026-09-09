ALTER TABLE profiles ADD COLUMN deploy_job_reference_id INTEGER REFERENCES build_references(id) ON DELETE SET NULL;
