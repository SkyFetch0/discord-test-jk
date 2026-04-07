import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import { SenneoLogo } from '../components/SenneoLogo';

export function LoginPage() {
  const { login, error, loading, passwordExpired, expiredUsername, clearPasswordExpired } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Forced-password-change form state
  const [oldPw, setOldPw]     = useState('');
  const [newPw, setNewPw]     = useState('');
  const [newPw2, setNewPw2]   = useState('');
  const [changing, setChanging] = useState(false);
  const [changeErr, setChangeErr] = useState('');
  const [changeOk, setChangeOk]   = useState(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim() || submitting) return;
    setSubmitting(true);
    const ok = await login(username.trim(), password);
    if (!ok) setSubmitting(false);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!oldPw || !newPw || newPw !== newPw2) return;
    if (newPw.length < 4) { setChangeErr('Şifre en az 4 karakter olmalı'); return; }
    setChanging(true); setChangeErr('');
    try {
      await api.auth.changePassword(oldPw, newPw);
      setChangeOk(true);
      setTimeout(() => { clearPasswordExpired(); setOldPw(''); setNewPw(''); setNewPw2(''); setChangeOk(false); }, 1500);
    } catch (err) {
      setChangeErr(err instanceof Error ? err.message : 'Şifre değiştirilemedi');
    } finally { setChanging(false); }
  }

  // U4 — Forced password change screen
  if (passwordExpired) {
    return (
      <div className="login-page">
        <div className="login-ambient-1" />
        <div className="login-ambient-2" />
        <div className="login-card">
          <div className="login-logo">
            <div className="login-logo-icon"><SenneoLogo size={36} glowIntensity="strong" /></div>
            <div className="login-logo-text">
              <div className="login-logo-name">Şifre Değiştir</div>
              <div className="login-logo-sub">{expiredUsername ?? 'Kullanıcı'}</div>
            </div>
          </div>
          <div style={{ height: 1, background: 'linear-gradient(90deg,transparent,rgba(255,69,58,0.3),transparent)', marginBottom: 24 }} />
          <div style={{ padding: '10px 14px', background: 'rgba(255,69,58,.08)', border: '1px solid rgba(255,69,58,.2)', borderRadius: 8, marginBottom: 20, fontSize: 12, color: '#ff6b6b', lineHeight: 1.5 }}>
            Şifrenizin süresi doldu. Devam etmek için yeni bir şifre belirlemeniz gerekmektedir.
          </div>
          {changeOk ? (
            <div style={{ padding: '14px 18px', background: 'rgba(48,209,88,.1)', border: '1px solid rgba(48,209,88,.25)', borderRadius: 8, fontSize: 13, color: '#30d158', fontWeight: 600, textAlign: 'center' }}>
              ✓ Şifre güncellendi. Giriş yapabilirsiniz.
            </div>
          ) : (
            <form className="login-form" onSubmit={handleChangePassword}>
              <div className="login-field">
                <label className="login-label">Mevcut Şifre</label>
                <input className="input login-input" type="password" placeholder="••••••••" value={oldPw} onChange={e => setOldPw(e.target.value)} disabled={changing} style={{ background: 'rgba(6,8,16,0.8)', border: '1px solid rgba(14,165,233,0.15)' }} />
              </div>
              <div className="login-field">
                <label className="login-label">Yeni Şifre</label>
                <input className="input login-input" type="password" placeholder="En az 4 karakter" value={newPw} onChange={e => setNewPw(e.target.value)} disabled={changing} style={{ background: 'rgba(6,8,16,0.8)', border: '1px solid rgba(14,165,233,0.15)' }} />
              </div>
              <div className="login-field">
                <label className="login-label">Yeni Şifre (Tekrar)</label>
                <input className="input login-input" type="password" placeholder="••••••••" value={newPw2} onChange={e => setNewPw2(e.target.value)} disabled={changing} style={{ background: 'rgba(6,8,16,0.8)', border: '1px solid rgba(14,165,233,0.15)' }} />
              </div>
              {newPw && newPw2 && newPw !== newPw2 && (
                <div className="login-error">Şifreler eşleşmiyor</div>
              )}
              {changeErr && <div className="login-error">{changeErr}</div>}
              <button type="submit" className="btn btn-primary login-btn" disabled={changing || !oldPw || !newPw || !newPw2 || newPw !== newPw2}>
                {changing ? <><div className="spin" style={{ width: 15, height: 15, borderWidth: 2 }} />Güncelleniyor…</> : 'Şifreyi Güncelle'}
              </button>
              <button type="button" className="btn login-btn" onClick={clearPasswordExpired}
                style={{ marginTop: 8, background: 'transparent', border: '1px solid var(--gb1)', color: 'var(--t3)' }}>
                Geri Dön
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-ambient-1" />
        <div className="login-ambient-2" />
        <div className="login-card">
          <div className="login-spinner"><div className="spin" style={{ width: 28, height: 28, borderWidth: 3 }} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-ambient-1" />
      <div className="login-ambient-2" />

      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <SenneoLogo size={36} glowIntensity="strong" />
          </div>
          <div className="login-logo-text">
            <div className="login-logo-name">Senneo</div>
            <div className="login-logo-sub">Intelligence Dashboard</div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'linear-gradient(90deg,transparent,rgba(14,165,233,0.2),transparent)', marginBottom: 28 }} />

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label className="login-label">Kullanıcı Adı</label>
            <input
              ref={inputRef}
              className="input login-input"
              type="text"
              placeholder="kullanici_adi"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              disabled={submitting}
              style={{ background: 'rgba(6,8,16,0.8)', border: '1px solid rgba(14,165,233,0.15)' }}
            />
          </div>

          <div className="login-field">
            <label className="login-label">Şifre</label>
            <input
              className="input login-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={submitting}
              style={{ background: 'rgba(6,8,16,0.8)', border: '1px solid rgba(14,165,233,0.15)' }}
            />
          </div>

          {error && (
            <div className="login-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary login-btn"
            disabled={submitting || !username.trim() || !password.trim()}
          >
            {submitting ? (
              <>
                <div className="spin" style={{ width: 15, height: 15, borderWidth: 2 }} />
                Giriş yapılıyor…
              </>
            ) : (
              'Giriş Yap'
            )}
          </button>
        </form>

        <div className="login-footer">
          Senneo &copy; {new Date().getFullYear()} · Tüm hakları saklıdır
        </div>
      </div>
    </div>
  );
}
