// Bearer-token auth for the Memory Explorer.
//
// No build-time secret: the user pastes the token into the login form and it is
// verified against the server (GET /api/stats). A local comparison would be pure
// decoration — anyone can set localStorage or curl the API — so only the server
// gates access. The token must match the server's MEMORY_AUTH_TOKEN.
// (This removes the old VITE_MEMORY_PASSWORD build-injection step, and with it
// the failure mode where a forgotten injection locked everyone out.)

const STORAGE_KEY = 'memory_web_auth_token';

export function getToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* private mode — the session just won't persist */
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Headers for every API call — carries the bearer token when we have one. */
export function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

/**
 * Ask the server whether a token is valid. Resolves true/false; a network
 * failure resolves false so the caller shows a retryable error rather than
 * assuming success.
 */
export async function verifyToken(token) {
  if (!token) return false;
  try {
    const res = await fetch('/api/stats', { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}
