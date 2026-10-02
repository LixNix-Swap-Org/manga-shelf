import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { saveUser, loadUser, loadMeta, clearOfflineData, syncOfflineCopy, formatAge } from './utils/offlineStore';

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

function OfflineBanner({ lastSync }) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/95 text-slate-950 text-xs font-semibold shadow-lg">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>
        Offline – Stand der Sammlung: {lastSync ? formatAge(lastSync) : 'unbekannt'}. Nur Ansicht, Änderungen sind erst mit Verbindung möglich.
      </span>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  useEffect(() => {
    checkStatus();
  }, []);

  // Keep the offline copy fresh: re-sync (throttled) whenever the app comes back to the foreground
  useEffect(() => {
    if (!user || user.offline) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') syncOfflineCopy(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user?.id, user?.offline]);

  // While the server is unreachable: retry in the background and as soon as the browser reports a connection
  useEffect(() => {
    if (!user?.offline) return undefined;
    const retry = () => { checkStatus(); };
    const timer = setInterval(retry, 30000);
    window.addEventListener('online', retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, [user?.offline]);

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
        saveUser(authData.user);
        syncOfflineCopy();
      } else if (authRes && authRes.status === 401) {
        // Session invalid or expired: drop the offline copy so it cannot be read without a login
        await clearOfflineData();
        setUser(null);
      } else {
        // Server unreachable (no network, proxy/gateway down): fall back to the last known user, read-only
        const cached = await loadUser();
        if (cached) {
          const meta = await loadMeta();
          setLastSync(meta?.synced_at || null);
          setUser({ ...cached, role: 'visitor', realRole: cached.role, offline: true });
        } else {
          setUser(null);
        }
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
      await clearOfflineData();
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
      {user?.offline && <OfflineBanner lastSync={lastSync} />}
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
