import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from './api';
import type { AuthUser } from './types';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  passwordExpired: boolean;
  expiredUsername: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearPasswordExpired: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  error: null,
  passwordExpired: false,
  expiredUsername: null,
  login: async () => false,
  logout: async () => {},
  refresh: async () => {},
  clearPasswordExpired: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordExpired, setPasswordExpired] = useState(false);
  const [expiredUsername, setExpiredUsername] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await (api.auth.me() as Promise<any>);
      setUser(data.user);
      if (data.passwordExpired) {
        setPasswordExpired(true);
        setExpiredUsername(data.user?.username ?? null);
      } else {
        setPasswordExpired(false);
      }
      setError(null);
    } catch {
      setUser(null);
    }
  }, []);

  // Check session on mount
  useEffect(() => {
    setLoading(true);
    (api.auth.me() as Promise<any>)
      .then(data => {
        setUser(data.user);
        if (data.passwordExpired) {
          setPasswordExpired(true);
          setExpiredUsername(data.user?.username ?? null);
        }
        setError(null);
      })
      .catch(() => { setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);
    setPasswordExpired(false);
    try {
      const data = await (api.auth.login(username, password) as Promise<any>);
      // U4: Password expired — login blocked until user changes it
      if (data.ok === false && data.passwordExpired) {
        setPasswordExpired(true);
        setExpiredUsername(data.username ?? username);
        setError('Şifrenizin süresi doldu. Lütfen şifrenizi değiştirin.');
        return false;
      }
      setUser(data.user);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Giris basarisiz');
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch { /* ignore */ }
    setUser(null);
    setPasswordExpired(false);
    setExpiredUsername(null);
    // Navigate to root
    window.history.pushState({}, '', '/');
  }, []);

  const clearPasswordExpired = useCallback(() => {
    setPasswordExpired(false);
    setExpiredUsername(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, passwordExpired, expiredUsername, login, logout, refresh, clearPasswordExpired }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
