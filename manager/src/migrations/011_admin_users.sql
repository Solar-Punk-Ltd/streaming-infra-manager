-- Who may manage users. Until now everyone signed in could add or remove
-- anyone, which is fine for one operator and wrong the moment there are two.
-- The first user, the one created on the host with the CLI, becomes the admin.
-- Later users are plain unless an admin says otherwise when adding them.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET is_admin = true
 WHERE id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);
