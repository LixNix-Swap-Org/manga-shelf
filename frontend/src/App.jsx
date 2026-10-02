import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

const Login = lazy(() => import('./Login'));
const Dashboard = lazy(() => import('./Dashboard'));
const MangaDetail = lazy(() => import('./MangaDetail'));
const Setup = lazy(() => import('./Setup'));

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-brand-400">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-brand-500/30 border-t-brand-500 rounded-full animate-spin" />
        <span className="text-xs font-medium text-slate-400">Manga Shelf wird geladen...</span>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      // Parallelize setup status check and auth check for instant initial load
      const [setupRes, authRes] = await Promise.all([
        fetch('/api/setup/status').catch(() => null),
        fetch('/api/auth/me').catch(() => null)
      ]);

      if (setupRes && setupRes.ok) {
        const setupData = await setupRes.json();
        if (setupData.needsSetup) {
          setNeedsSetup(true);
          setLoading(false);
          return;
        }
      }

      if (authRes && authRes.ok) {
        const authData = await authRes.json();
        setUser(authData.user);
      } else {
        setUser(null);
      }
    } catch (e) {
      console.error(e);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      console.error('Logout error:', e);
    } finally {
      setUser(null);
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  if (needsSetup) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <Setup onComplete={() => { setNeedsSetup(false); checkStatus(); }} />
      </Suspense>
    );
  }

  return (
    <Router>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/login" element={!user ? <Login onLogin={checkStatus} /> : <Navigate to="/" />} />
          <Route path="/" element={user ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" />} />
          <Route path="/manga/:id" element={user ? <MangaDetail user={user} /> : <Navigate to="/login" />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
