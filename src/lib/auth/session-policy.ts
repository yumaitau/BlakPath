/**
 * Password reset must end existing sessions. Better Auth only does that when
 * this flag is set; the library default leaves old sessions valid.
 */
export const REVOKE_SESSIONS_ON_PASSWORD_RESET = true;
