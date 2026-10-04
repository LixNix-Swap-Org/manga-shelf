import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { WifiOff, RotateCw } from 'lucide-react';
import { saveUser, loadUser, loadMeta, clearOfflineData, syncOfflineCopy, formatAge } from './utils/offlineStore';
import { flushPurchaseQueue, pendingCount } from './utils/shoppingQueue';
import { SESSION_EXPIRED_EVENT, clearMangaListCache } from './hooks/useMangaList';
import { apiFetch } from './utils/api';
import { setToken } from './app/connection';
import AppErrorBoundary from './AppErrorBoundary';
import Toaster from './components/common/Toaster';
import {
  MESSAGES, STARTUP_TIMEOUT_MS, UPDATE_AVAILABLE_EVENT, readJson, isLogoutPending, markLogoutPending,
  clearLogoutPending, postLogout, flushPendingLogout, clearUploadsCache, clearSearchState, safeRedirectTarget, runBeforeLogout
} from './appShell';

/** Starts loading a route chunk now; the lazy() factory reuses the request and retries once if it failed. */
function preloadable(load, startNow) {
  let pending = startNow ? load() : null;
  pending?.catch(() => {});
  return () => {
    const request = pending ?? load();
    pending = null;
    return request.catch(() => load());
  };
}

// The page chunk of the start URL loads in parallel with the session check instead of after it
const START_PATH = typeof window !== 'undefined' ? window.location.pathname : '';
const Login = lazy(() => import('./Login'));
const Dashboard = lazy(preloadable(() => import('./Dashboard'), START_PATH === '/'));
const MangaDetail = lazy(preloadable(() => import('./MangaDetail'), START_PATH.startsWith('/manga/')));
const Setup = lazy(() => import('./Setup'));

// the snapshot download (several MB) waits until the first page has had its own requests
const SYNC_DELAY_MS = 3000;
function syncWhenIdle() {
  const run = () => { syncOfflineCopy(); };
  if (typeof window.requestIdleCallback === 'function') {
    setTimeout(() => window.requestIdleCallback(run, { timeout: SYNC_DELAY_MS }), SYNC_DELAY_MS);
  } else {
    setTimeout(run, SYNC_DELAY_MS);
  }
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-brand-400">
      <div role="status" className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-brand-500/30 border-t-brand-500 rounded-full animate-spin" aria-hidden="true" />
        <span className="text-xs font-medium text-slate-400">Manga Shelf wird geladen...</span>
      </div>
    </div>
  );
}

const SAFE_AREA_BOTTOM = {
  paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
  paddingLeft: 'calc(1rem + env(safe-area-inset-left, 0px))',
  paddingRight: 'calc(1rem + env(safe-area-inset-right, 0px))'
};

function OfflineBanner({ lastSync }) {
  return (
    <div role="status" style={SAFE_AREA_BOTTOM} className="fixed bottom-0 inset-x-0 z-40 flex items-center justify-center gap-2 pt-2 bg-amber-500/95 text-slate-950 text-xs font-semibold shadow-lg">
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>
        Offline – Stand der Sammlung: {lastSync ? formatAge(lastSync) : 'unbekannt'}.
        <span className="hidden sm:inline"> Nur Ansicht, Änderungen sind erst mit Verbindung möglich.</span>
      </span>
    </div>
  );
}

function UpdateBanner() {
  return (
    <div role="status" className="fixed top-[max(0.75rem,env(safe-area-inset-top))] inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-brand-500/40 bg-slate-900/95 px-4 py-2 text-xs font-semibold text-slate-100 shadow-xl">
        Neue Version verfügbar
        <button type="button" onClick={() => window.location.reload()} className="flex items-center gap-1 rounded-full bg-brand-700 px-3 py-1 text-white hover:bg-brand-800">
          <RotateCw className="w-3.5 h-3.5" aria-hidden="true" /> Neu laden
        </button>
      </div>
    </div>
  );
}

function RouteBoundary({ children }) {
  const location = useLocation();
  return <AppErrorBoundary resetKey={location.pathname}>{children}</AppErrorBoundary>;
}

function RequireAuth({ user, children }) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

function LoginRoute({ user, onLogin, notice }) {
  const location = useLocation();
  if (user) return <Navigate to={safeRedirectTarget(location.state?.from)} replace />;
  return <Login onLogin={onLogin} notice={notice} />;
}

const sameUser = (a, b) => Boolean(a && b) && a.id === b.id && a.username === b.username
  && a.role === b.role && Boolean(a.offline) === Boolean(b.offline);

const timed = (url) => apiFetch(url, { timeout: STARTUP_TIMEOUT_MS }).catch(() => null);

async function offlineFallback() {
  const cached = await loadUser();
  if (!cached) return { status: 'unreachable', user: null };
  const meta = await loadMeta();
  return {
    status: 'offline',
    user: { ...cached, role: 'visitor', realRole: cached.role, offline: true },
    lastSync: meta?.synced_at || null
  };
}

/**
 * Startup / re-check decision: 'setup', 'online', 'unauthorized' (the app's own 401), 'logoutPending' /
 * 'loggedOut' (a logout that had not reached the server), 'offline' (cached user) or 'unreachable'.
 * Network errors, timeouts and non-JSON answers (captive portal, proxy page) count as "server unreachable".
 */
async function resolveStatus() {
  const logoutPending = isLogoutPending();
  const [setupRes, authRes, logoutDone] = await Promise.all([
    timed('/api/setup/status'),
    logoutPending ? null : timed('/api/auth/me'),
    logoutPending ? flushPendingLogout({ timeoutMs: STARTUP_TIMEOUT_MS }) : true
  ]);

  if (setupRes?.ok && (await readJson(setupRes))?.needsSetup) return { status: 'setup', user: null };
  // Never use the old session while its logout is still outstanding
  if (logoutPending) return { status: logoutDone ? 'loggedOut' : 'logoutPending', user: null };

  if (authRes?.ok) {
    const data = await readJson(authRes);
    if (data?.user) return { status: 'online', user: data.user };
  } else if (authRes?.status === 401 && await readJson(authRes)) {
    return { status: 'unauthorized', user: null };
  }
  return offlineFallback();
}

// scanHelpers.SCAN_LIST_KEY and its older sessionStorage name (not imported: keeps the scan helpers out of the start chunk)
const SCAN_LIST_KEYS = ['mangashelf_shop_session', 'mangashelf_shop_scan'];
function clearScanList() {
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      for (const key of SCAN_LIST_KEYS) window[storage].removeItem(key);
    } catch (_) { /* storage unavailable */ }
  }
}

// shelf page count and scroll positions (MangaCollectionGrid, MangaDetail): the next user starts at the top
const VIEW_STATE_KEYS = ['mangashelf_shelf_count', 'mangashelf_shelf_scroll', 'mangashelf_detail_scroll'];
function clearViewState() {
  try {
    for (const key of VIEW_STATE_KEYS) window.sessionStorage.removeItem(key);
  } catch (_) { /* storage unavailable */ }
}

async function clearSessionData() {
  clearMangaListCache();
  clearSearchState();
  clearScanList();
  clearViewState();
  await Promise.all([clearOfflineData(), clearUploadsCache()]);
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [notice, setNotice] = useState(null);
  const [updateReady, setUpdateReady] = useState(false);
  const userRef = useRef(null);
  const runSeq = useRef(0);
  const checking = useRef(0);
  const loggingOut = useRef(false);
  const expiring = useRef(null);

  useEffect(() => { userRef.current = user; }, [user]);

  const applyUser = useCallback((next) => {
    setUser((prev) => (sameUser(prev, next) ? prev : next));
  }, []);

  const checkStatus = useCallback(async () => {
    const seq = ++runSeq.current;
    checking.current++;
    try {
      let outcome;
      try {
        outcome = await resolveStatus();
      } catch (e) {
        console.error('[App] Status check failed:', e);
        outcome = await offlineFallback();
      }
      // A newer check, a logout or a runtime 401 happened meanwhile: this result is stale
      if (seq !== runSeq.current) return outcome;

      if (outcome.status === 'unauthorized') {
        const wasSignedIn = Boolean(userRef.current);
        setToken(null);
        await clearSessionData();
        if (seq !== runSeq.current) return outcome;
        if (wasSignedIn) setNotice(MESSAGES.sessionExpired);
      }

      switch (outcome.status) {
        case 'setup':
          setNeedsSetup(true);
          break;
        case 'online':
          applyUser(outcome.user);
          setLastSync(null);
          saveUser(outcome.user);
          syncWhenIdle();
          break;
        case 'offline':
          setLastSync(outcome.lastSync);
          applyUser(outcome.user);
          break;
        case 'logoutPending':
          setNotice(MESSAGES.logoutPending);
          setUser(null);
          break;
        default:
          setUser(null);
      }
      return outcome;
    } finally {
      checking.current--;
      setLoading(false);
    }
  }, [applyUser]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Runtime 401 (session revoked, password changed elsewhere, user deleted, expired): same cleanup as a logout.
  // Several requests can fail at once, so concurrent calls share one run.
  const handleUnauthorized = useCallback(() => {
    if (loggingOut.current || !userRef.current) return Promise.resolve();
    if (expiring.current) return expiring.current;
    runSeq.current++;
    userRef.current = null;
    expiring.current = (async () => {
      setToken(null);
      await clearSessionData();
      setNotice(MESSAGES.sessionExpired);
      setLastSync(null);
      setUser(null);
    })().finally(() => { expiring.current = null; });
    return expiring.current;
  }, []);

  useEffect(() => {
    const onExpired = () => { handleUnauthorized(); };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [handleUnauthorized]);

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener(UPDATE_AVAILABLE_EVENT, onUpdate);
    return () => window.removeEventListener(UPDATE_AVAILABLE_EVENT, onUpdate);
  }, []);

  // Back in the foreground: check the session first (the throttled snapshot sync often sends no request at all),
  // then refresh the offline copy.
  const onlineSession = Boolean(user && !user.offline);
  useEffect(() => {
    if (!onlineSession) return undefined;
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const res = await timed('/api/auth/me');
      if (res?.status === 401 && await readJson(res)) {
        handleUnauthorized();
        return;
      }
      if (!res?.ok) return;
      const data = await readJson(res);
      if (data?.user && userRef.current && !userRef.current.offline) {
        applyUser(data.user);
        saveUser(data.user);
      }
      syncOfflineCopy();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [onlineSession, handleUnauthorized, applyUser]);

  // While the server is unreachable: retry in the background and as soon as the browser reports a connection
  useEffect(() => {
    if (!user?.offline) return undefined;
    const retry = () => { if (checking.current === 0) checkStatus(); };
    const timer = setInterval(retry, 30000);
    window.addEventListener('online', retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
    };
  }, [user?.offline, checkStatus]);

  // A logout that could not reach the server is sent as soon as the connection is back
  useEffect(() => {
    if (user || loading) return undefined;
    const onOnline = async () => {
      if (isLogoutPending() && await flushPendingLogout()) {
        setNotice((n) => (n === MESSAGES.logoutPending ? null : n));
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user, loading]);

  const handleLogin = useCallback(async () => {
    // The new session replaces the old cookie: an outstanding logout must not end it on the next start
    clearLogoutPending();
    setNotice(null);
    return checkStatus();
  }, [checkStatus]);

  const handleSetupComplete = useCallback(async ({ adminExists = false } = {}) => {
    clearLogoutPending();
    setNotice(adminExists ? MESSAGES.adminExists : null);
    setNeedsSetup(false);
    const outcome = await checkStatus();
    if (!adminExists && outcome?.status === 'unauthorized') setNotice(MESSAGES.cookieRejected);
    return outcome;
  }, [checkStatus]);

  const handleLogout = useCallback(async () => {
    const current = userRef.current;
    loggingOut.current = true;
    runSeq.current++;
    try {
      // quick buys still in their undo window are sent (or queued) while the session is valid
      if (current) await runBeforeLogout();
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (current && !current.offline && online) {
        try { await flushPurchaseQueue({ userId: current.id }); } catch (_) { /* stays queued */ }
      }
      const queued = current ? pendingCount(current.id) : 0;
      // Set before the request: if it never arrives, the next start sends it again instead of reusing the cookie
      markLogoutPending();
      const done = await postLogout();
      if (done) clearLogoutPending();
      await clearSessionData();
      setNotice(!done ? MESSAGES.logoutPending : (queued > 0 ? MESSAGES.purchasesQueued : null));
      setLastSync(null);
      userRef.current = null;
      setUser(null);
    } finally {
      loggingOut.current = false;
    }
  }, []);

  let content;
  if (loading) {
    content = <LoadingScreen />;
  } else if (needsSetup) {
    content = (
      <AppErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <Setup onComplete={handleSetupComplete} />
        </Suspense>
      </AppErrorBoundary>
    );
  } else {
    content = (
      <Router>
        {updateReady && <UpdateBanner />}
        {user?.offline && <OfflineBanner lastSync={lastSync} />}
        <RouteBoundary>
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/login" element={<LoginRoute user={user} onLogin={handleLogin} notice={notice} />} />
              <Route path="/" element={<RequireAuth user={user}><Dashboard user={user} onLogout={handleLogout} /></RequireAuth>} />
              <Route path="/manga/:id" element={<RequireAuth user={user}><MangaDetail user={user} onUnauthorized={handleUnauthorized} /></RequireAuth>} />
              <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
            </Routes>
          </Suspense>
        </RouteBoundary>
      </Router>
    );
  }

  return (
    <>
      {content}
      <Toaster />
    </>
  );
}

export default App;
