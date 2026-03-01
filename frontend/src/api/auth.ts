import api from './client';

export interface AuthResponse {
  user: { id: string; email: string; name?: string; picture?: string };
}

export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  const { data } = await api.post<AuthResponse>('/api/auth/google', { id_token: idToken });
  return data;
}

export async function getMe(): Promise<{ id: string; email: string; name?: string; picture?: string }> {
  const { data } = await api.get('/api/me');
  return data;
}

export async function logout(): Promise<void> {
  await api.post('/api/logout');
}
