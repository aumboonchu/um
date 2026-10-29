-- Optional profile image from a verified Google ID token. Existing sessions remain valid.
ALTER TABLE users ADD COLUMN avatar_url TEXT;
