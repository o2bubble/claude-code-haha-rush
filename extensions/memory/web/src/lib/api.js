import { authHeaders, notifyUnauthorized } from './auth';

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  if (res.status === 401) {
    // Drop the rejected token and let the auth layer re-render the login gate.
    // Do NOT reload here: the data-loading effects run regardless of auth, so
    // a reload would re-issue the same 401 forever (observed as an endless
    // refresh loop). Clearing the token flips the auth state instead.
    notifyUnauthorized();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Read
export function getStats() {
  return request('/stats');
}

export function getMemories(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      q.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }
  return request('/memories?' + q.toString());
}

export function getMemory(id) {
  return request('/memories/' + encodeURIComponent(id));
}

export function getTags(scope) {
  const q = scope ? '?scope=' + encodeURIComponent(scope) : '';
  return request('/tags' + q);
}

export function getGraph(startId, maxDepth, filters) {
  const q = new URLSearchParams();
  if (startId) q.set('start_id', startId);
  if (maxDepth) q.set('max_depth', maxDepth);
  if (filters) {
    if (filters.q) q.set('q', filters.q);
    if (filters.type) q.set('type', filters.type);
    if (filters.scope) q.set('scope', filters.scope);
    if (filters.tags && filters.tags.length) q.set('tags', filters.tags.join(','));
  }
  return request('/graph?' + q.toString());
}

// Write
export function createMemory(data) {
  return request('/memories', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateMemory(id, data) {
  return request('/memories/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteMemory(id) {
  return request('/memories/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
}

export function createAssociation(data) {
  return request('/associations', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteAssociation(data) {
  return request('/associations', {
    method: 'DELETE',
    body: JSON.stringify(data),
  });
}

export function normalizeTags(data) {
  return request('/tags/normalize', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
