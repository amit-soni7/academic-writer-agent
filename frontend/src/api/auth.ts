import api from './client';

export interface AuthResponse {
  user: { id: string; email: string; name?: string; picture?: string };
}

/** Redirect the browser to the backend's Google OAuth login endpoint. */
export function redirectToGoogleLogin(): void {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8010';
  window.location.href = `${base}/api/auth/google/login`;
}

export async function getMe(): Promise<{ id: string; email: string; name?: string; picture?: string }> {
  const { data } = await api.get('/api/me');
  return data;
}

export async function logout(): Promise<void> {
  await api.post('/api/logout');
}
