ALTER TABLE profiles ADD COLUMN deployment_phase TEXT
  CHECK (deployment_phase IN ('starting', 'restarting'));
