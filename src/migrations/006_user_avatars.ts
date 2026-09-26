/**
 * 006_user_avatars — a user's uploaded photo. `avatar_url` is the public
 * Vercel Blob URL of the normalised square (services/avatar.ts); NULL means
 * the initials avatar the page draws. A group shows it for each linked
 * member, so it is part of the group cache key (repo.ts USERS_KEY_SQL).
 */
const sql = String.raw`
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
`;

export default sql;
