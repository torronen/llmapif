const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

const TOKEN_KEY = 'freellmapi-admin-token'

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}
export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// Fired when an /api call is rejected with 401 so the app can drop back to the
// login screen instead of surfacing a generic error.
export const UNAUTHORIZED_EVENT = 'admin-unauthorized'

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAdminToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    ...options,
  })

  if (res.status === 401) {
    clearAdminToken()
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    throw new Error('Admin authentication required')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchAuthStatus(): Promise<{ authRequired: boolean }> {
  const res = await fetch(`${BASE}/api/auth/status`)
  if (!res.ok) return { authRequired: false }
  return res.json()
}

/** Returns the issued token on success, or throws with a message on failure. */
export async function login(password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`)
  }
  if (body.token) setAdminToken(body.token)
  return body.token ?? null
}
