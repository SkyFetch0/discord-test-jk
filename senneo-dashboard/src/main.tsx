import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider, useAuth } from './AuthContext'
import { LoginPage } from './pages/LoginPage'
import { UserHome } from './pages/UserHome'
import App from './App'
import './styles/globals.css'

function AppRouter() {
  const { user, loading } = useAuth();
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Also update path when user changes (login/logout triggers pushState)
  useEffect(() => {
    setPath(window.location.pathname);
  }, [user]);

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)' }}>
        <div className="spin" style={{ width: 24, height: 24 }} />
      </div>
    );
  }

  // Not logged in (or password expired without active session) → login/change-password page
  if (!user) {
    return <LoginPage />;
  }

  // U4: Logged-in user with expired password → force change screen via UserHome banner
  // (they are logged in but must change before full access)

  // Logged in + /admin path
  const isAdminPath = path === '/admin' || path.startsWith('/admin/');
  if (isAdminPath) {
    if (user.role === 'admin') {
      return <App />;
    }
    // U1: Non-admin with allowedPages can access admin dashboard (filtered)
    if (user.allowedPages && user.allowedPages.length > 0) {
      return <App />;
    }
    // Non-admin without allowedPages → redirect to home
    window.history.replaceState({}, '', '/');
    return <UserHome />;
  }

  // Logged in + root path
  // Admins see UserHome by default (they can click to go to /admin)
  // Normal users always see user home
  return <UserHome />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  </React.StrictMode>,
)
