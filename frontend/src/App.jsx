import { useState, useEffect, useLayoutEffect, useRef, useCallback, useSyncExternalStore, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { saveUser, loadUser, loadMeta, clearOfflineData, syncOfflineCopy } from './utils/offlineStore';
import { SESSION_EXPIRED_EVENT, clearMangaListCache } from './hooks/useMangaList';
import { apiFetch, isAppMode, isLocalMode } from './utils/api';
import {
  dropRejectedToken, checkConnection, activateServer, startConnectionManager, subscribeConnection, getConnection
} from './app/connection';
import { loadServers, getActiveServer, getActiveServerId } from './app/serverStore';
import { DEEP_LINK_EVENT, SHARE_LINK_EVENT, hasPendingShare, takePendingDeepLink } from './app/deepLink';
import { useActiveServer } from './app/useConnection';
import { cancelAllDownloads } from './app/downloadManager';
import { getLocalRuntime, resetLocalRuntime, onSourceBlocked } from './local/localTransport';
import { enterLocalMode, leaveLocalMode, subscribeMode, getLocalProfile } from './local/profile';
import { LOCAL_STORE_EVENT, SAVE_FAILED_TEXT, LOCKED_TEXT, CONFLICT_TEXT } from './local/store';
import { notify } from './utils/notify';
import AppErrorBoundary from './AppErrorBoundary';
import { clearViewState, endViewSession, startViewSession } from './utils/viewState';
import Toaster from './components/common/Toaster';
import OfflineBanner from './components/common/OfflineBanner';
import {
  MESSAGES, STARTUP_TIMEOUT_MS, readJson, isLogoutPending, markLogoutPending,
  clearLogoutPending, postLogout, flushPendingLogout, clearUploadsCache, clearSearchState, safeRedirectTarget, runBeforeLogout
} from './appShell';
import { dialogEntryOnTop } from './hooks/useDialogA11y';
import { useRevealFocusedField } from './hooks/useKeyboardOpen';
import useWatchSync from './app/watch/useWatchSync';

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
const ServerScreen = lazy(() => import('./app/ServerScreen'));
const LocalScreen = lazy(() => import('./app/LocalScreen'));
const LocalSetup = lazy(() => import('./app/LocalSetup'));
// the outbox (and its patch helpers) stays out of the start chunk
const loadOutbox = () => import('./utils/outbox');

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

function RouteBoundary({ children }) {
  const location = useLocation();
  return <AppErrorBoundary resetKey={location.pathname}>{children}</AppErrorBoundary>;
}

function RequireAuth({ user, children }) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return children;
}

function LoginRoute({ user, onLogin, notice, onRetry, hasServer }) {
  const location = useLocation();
  if (user) return <Navigate to={safeRedirectTarget(location.state?.from)} replace />;
  // the standalone mode has no login: its device screen opens the collection
  if (!hasServer || isLocalMode()) return <Navigate to="/server" replace />;
  return <Login onLogin={onLogin} notice={notice} onRetry={onRetry} />;
}

// app build: a manga-shelf://connect link opens the server screen, which takes the link from deepLink.js; a shared
// streaming link opens the anime tab, whose dashboard takes it (the dashboard itself handles one while it is shown)
function DeepLinkListener() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  useEffect(() => {
    const open = () => navigate('/server', { state: { deepLink: Date.now() } });
    const openShare = () => {
      if (pathRef.current !== '/') navigate('/?view=anime', { state: { share: Date.now() } });
    };
    const pending = takePendingDeepLink();
    if (pending) navigate('/server', { state: { link: pending } });
    else if (hasPendingShare()) openShare();
    window.addEventListener(DEEP_LINK_EVENT, open);
    window.addEventListener(SHARE_LINK_EVENT, openShare);
    return () => {
      window.removeEventListener(DEEP_LINK_EVENT, open);
      window.removeEventListener(SHARE_LINK_EVENT, openShare);
    };
  }, [navigate]);
  return null;
}

// the setup screens are long: the shelf they lead to opens at the top, not at their scroll offset
const SETUP_PATHS = new Set(['/lokal', '/server']);
function ScrollTopAfterSetup() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useLayoutEffect(() => {
    if (pathname === '/' && SETUP_PATHS.has(previous.current) && window.scrollY > 0) window.scrollTo(0, 0);
    previous.current = pathname;
  }, [pathname]);
  return null;
}

// desktop menu "Quellen & Schlüssel…" (desktop/preload.js): handled on every route of a signed-in user; left alone
// without a user, so the desktop asks to sign in first
const OPEN_API_KEYS_EVENT = 'mangashelf:open-api-keys';
// the mounted shelf opens the dialog in place, so the history entries of its open dialogs stay as they are
const OPEN_ACCOUNT_EVENT = 'mangashelf:open-account';
const KEYS_OFFLINE = 'Quellen & Schlüssel lassen sich nur mit Verbindung zum Server bearbeiten.';

function ApiKeysMenuListener({ user }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const signedIn = Boolean(user);
  const offline = Boolean(user?.offline);
  useEffect(() => {
    if (!signedIn) return undefined;
    const onKeys = (event) => {
      event.preventDefault();
      if (offline) {
        notify.info(KEYS_OFFLINE);
        return;
      }
      const onShelf = pathname === '/';
      if (onShelf && !window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_EVENT, { detail: 'keys', cancelable: true }))) return;
      navigate(
        { pathname: '/', search: onShelf ? search : '' },
        { replace: onShelf || dialogEntryOnTop(), state: { openAccount: 'keys' } }
      );
    };
    window.addEventListener(OPEN_API_KEYS_EVENT, onKeys);
    return () => window.removeEventListener(OPEN_API_KEYS_EVENT, onKeys);
  }, [signedIn, offline, pathname, search, navigate]);
  return null;
}

const OUTBOX_QUEUED = 'Vorgemerkte Änderungen werden bei deiner nächsten Anmeldung auf diesem Gerät übertragen.';

const sameUser = (a, b) => Boolean(a && b) && a.id === b.id && a.username === b.username
  && a.role === b.role && Boolean(a.offline) === Boolean(b.offline) && Boolean(a.local) === Boolean(b.local);

const LOCAL_FAILED = 'Die Sammlung auf diesem Gerät konnte nicht geöffnet werden';

/** Standalone mode: the core on the device answers for the local profile (role admin, no login). */
async function resolveLocal() {
  try {
    const rt = await getLocalRuntime();
    return { status: 'local', user: { ...rt.getProfile(), local: true }, storeStatus: rt.status?.() ?? null };
  } catch (e) {
    return { status: 'localFailed', user: null, error: `${LOCAL_FAILED}: ${e?.message || e}` };
  }
}

const localModeNow = () => isLocalMode();

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
 * Startup / re-check decision: 'setup', 'online', 'unauthorized', 'logoutPending' / 'loggedOut' (a logout that never
 * reached the server), 'offline' (cached user) or 'unreachable' (network error, timeout or non-JSON answer).
 */
async function resolveStatus() {
  if (isLocalMode()) return resolveLocal();
  if (isAppMode()) {
    await loadServers();
    if (!getActiveServer()) return { status: 'noServer', user: null };
    // none of the server's addresses answers: straight to the offline copy instead of three timeouts
    if ((await checkConnection()).state !== 'online') return offlineFallback();
  }
  const logoutPending = isLogoutPending();
  // browser build: the cookie of the logged-out session is still there. App build: the pending logout holds the old
  // token itself, so a new login's session can be checked right away.
  const blockSession = logoutPending && !isAppMode();
  const [setupRes, authRes, logoutDone] = await Promise.all([
    timed('/api/setup/status'),
    blockSession ? null : timed('/api/auth/me'),
    logoutPending ? flushPendingLogout({ timeoutMs: STARTUP_TIMEOUT_MS }) : true
  ]);

  if (setupRes?.ok && (await readJson(setupRes))?.needsSetup) return { status: 'setup', user: null };
  // Never use the old session while its logout is still outstanding
  if (blockSession) return { status: logoutDone ? 'loggedOut' : 'logoutPending', user: null };

  if (authRes?.ok) {
    const data = await readJson(authRes);
    if (data?.user) return { status: 'online', user: data.user };
  } else if (authRes?.status === 401 && await readJson(authRes)) {
    return logoutPending ? { status: logoutDone ? 'loggedOut' : 'logoutPending', user: null } : { status: 'unauthorized', user: null };
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

async function clearSessionData() {
  clearMangaListCache();
  clearSearchState();
  clearScanList();
  endViewSession();
  await Promise.all([clearOfflineData(), clearUploadsCache()]);
}

const reloadPage = () => window.location.reload();

/** Lasting notices of the device database: saving fails, another window holds it, or another window saved newer data. */
function useLocalStoreNotices() {
  const shown = useRef({ save: null, lock: null });
  return useCallback((status) => {
    if (!status) return;
    const toggle = (slot, wanted, show) => {
      if (wanted && shown.current[slot] === null) shown.current[slot] = show();
      else if (!wanted && shown.current[slot] !== null) {
        notify.dismiss(shown.current[slot]);
        shown.current[slot] = null;
      }
    };
    const reload = { label: 'Neu laden', onClick: reloadPage };
    toggle('save', Boolean(status.saveError) && !status.conflict, () => notify.error(SAVE_FAILED_TEXT, { duration: 0 }));
    toggle('lock', Boolean(status.follower || status.conflict), () => (status.conflict
      ? notify.error(CONFLICT_TEXT, { duration: 0, action: reload })
      : notify.info(LOCKED_TEXT, { duration: 0, action: reload })));
  }, []);
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [notice, setNotice] = useState(null);
  const activeServer = useActiveServer();
  const localMode = useSyncExternalStore(subscribeMode, localModeNow, localModeNow);
  const userRef = useRef(null);
  const runSeq = useRef(0);
  const checking = useRef(0);
  const loggingOut = useRef(false);
  const expiring = useRef(null);
  const replacing = useRef(null);
  const showStoreStatus = useLocalStoreNotices();
  useRevealFocusedField();

  useEffect(() => { userRef.current = user; }, [user]);

  // the pages of the previous session have unmounted by now (their cleanups ran in the commit): drop what they stored
  const signedIn = Boolean(user);
  const hadUser = useRef(false);
  useEffect(() => {
    if (signedIn) {
      hadUser.current = true;
      startViewSession();
    } else if (hadUser.current) {
      hadUser.current = false;
      clearViewState();
    }
  }, [signedIn]);

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
        dropRejectedToken();
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
        case 'noServer':
          setNeedsSetup(false);
          setUser(null);
          break;
        case 'local':
          setNeedsSetup(false);
          setLastSync(null);
          applyUser(outcome.user);
          showStoreStatus(outcome.storeStatus);
          break;
        case 'localFailed':
          setNeedsSetup(false);
          setNotice(outcome.error);
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
  }, [applyUser, showStoreStatus]);

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
      cancelAllDownloads();
      dropRejectedToken();
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

  useEffect(() => (isAppMode() ? startConnectionManager() : undefined), []);

  // apps: the opt-in Crunchyroll history sync runs in the foreground for a signed-in user or the opened device collection
  useWatchSync(user, localMode ? 'local' : activeServer?.id ?? 'server');

  // standalone in the browser build: a source without CORS headers is named once instead of failing silently
  useEffect(() => {
    if (!isAppMode()) return undefined;
    onSourceBlocked((host) => notify.info(`${host} lässt Anfragen aus dem Browser nicht zu (CORS) – diese Quelle funktioniert in der App oder mit einem Server.`));
    return () => onSourceBlocked(null);
  }, []);

  // Back in the foreground: check the session first (the throttled snapshot sync often sends no request at all),
  // then refresh the offline copy.
  const onlineSession = Boolean(user && !user.offline && !user.local);
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

  // While the server is unreachable: retry in the background and as soon as the browser (or, in the app build, the
  // connection manager) reports a connection
  useEffect(() => {
    if (!user?.offline) return undefined;
    const retry = () => { if (checking.current === 0) checkStatus(); };
    const timer = setInterval(retry, 30000);
    window.addEventListener('online', retry);
    let last = getConnection().state;
    const unsubscribe = isAppMode()
      ? subscribeConnection(() => {
        const next = getConnection().state;
        if (next === 'online' && last !== 'online') retry();
        last = next;
      })
      : null;
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
      unsubscribe?.();
    };
  }, [user?.offline, checkStatus]);

  // Outbox: queued changes go out after the login, on reconnect and on return to the foreground. The device core of the
  // standalone mode answers directly: no outbox there, so no server's queued change can reach it.
  const sessionUserId = user && !user.offline && !user.local ? user.id : null;
  useEffect(() => {
    if (sessionUserId === null || sessionUserId === undefined) return undefined;
    let stop = null;
    let cancelled = false;
    loadOutbox().then(({ startOutboxSync }) => {
      if (cancelled) return;
      let last = getConnection().state;
      stop = startOutboxSync({
        userId: sessionUserId,
        isOnline: () => getConnection().state !== 'offline',
        subscribe: isAppMode()
          ? (onReconnect) => subscribeConnection(() => {
            const next = getConnection().state;
            if (next === 'online' && last !== 'online') onReconnect();
            last = next;
          })
          : undefined
      });
    }).catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [sessionUserId]);

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

  // app build: logouts of the other saved servers go out (each to its own addresses) when the network is back
  useEffect(() => {
    if (!isAppMode()) return undefined;
    const flushAll = () => { flushPendingLogout({ all: true }).catch(() => {}); };
    let last = getConnection().state;
    const unsubscribe = subscribeConnection(() => {
      const next = getConnection().state;
      if (next === 'online' && last !== 'online') flushAll();
      last = next;
    });
    window.addEventListener('online', flushAll);
    return () => {
      unsubscribe();
      window.removeEventListener('online', flushAll);
    };
  }, []);

  const handleLogin = useCallback(async () => {
    // The new session replaces the old cookie: an outstanding logout must not end it on the next start
    clearLogoutPending();
    setNotice(null);
    return checkStatus();
  }, [checkStatus]);

  // app build: another saved server (or the same one again) was chosen on the server screen
  const handleServerSelected = useCallback(async (serverId) => {
    if (serverId !== getActiveServerId() || isLocalMode()) {
      cancelAllDownloads();
      if (isLocalMode()) {
        leaveLocalMode();
        await resetLocalRuntime();
      }
      runSeq.current++;
      userRef.current = null;
      setUser(null);
      setLastSync(null);
      setNeedsSetup(false);
      // the offline copy, caches and search belong to the previous server; its outbox entries stay with it
      await clearSessionData();
    }
    activateServer(serverId);
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

  // Standalone: leaves the collection open on the device screen; nothing to sign out from, nothing is deleted
  const closeLocal = useCallback(async () => {
    runSeq.current++;
    cancelAllDownloads();
    await getLocalRuntime().then((rt) => rt.flush()).catch(() => {});
    userRef.current = null;
    setUser(null);
  }, []);

  /** Switches to the standalone mode (new or existing local collection) and opens it. */
  const openLocal = useCallback(async (profile) => {
    const wasLocal = isLocalMode();
    runSeq.current++;
    cancelAllDownloads();
    userRef.current = null;
    setUser(null);
    setLastSync(null);
    setNotice(null);
    enterLocalMode(profile);
    if (profile) await resetLocalRuntime();
    // caches, offline copy and search belong to the previous server (or profile)
    if (!wasLocal || profile) await clearSessionData();
    return checkStatus();
  }, [checkStatus]);

  const handleStartLocal = useCallback(({ name }) => openLocal({ id: null, name }), [openLocal]);
  const handleOpenLocal = useCallback(() => openLocal(), [openLocal]);
  const handleSwitchProfile = useCallback((profile) => openLocal(profile), [openLocal]);

  // a restore replaced the local collection: drop the list caches, read the profile again (one run per restore, whether
  // the device screen or the runtime's event asks first)
  const handleLocalReplaced = useCallback(() => {
    if (!replacing.current) {
      replacing.current = (async () => {
        await clearSessionData();
        return checkStatus();
      })().finally(() => { replacing.current = null; });
    }
    return replacing.current;
  }, [checkStatus]);

  // the device database reports saving problems, another window and restores (also those started from the dashboard)
  useEffect(() => {
    if (!isAppMode()) return undefined;
    const onStore = (event) => {
      const { type, status } = event.detail || {};
      showStoreStatus(status);
      if (type === 'replaced' && isLocalMode() && userRef.current?.local) handleLocalReplaced();
    };
    window.addEventListener(LOCAL_STORE_EVENT, onStore);
    return () => window.removeEventListener(LOCAL_STORE_EVENT, onStore);
  }, [handleLocalReplaced, showStoreStatus]);

  const handleLeaveLocal = useCallback(async () => {
    runSeq.current++;
    cancelAllDownloads();
    await getLocalRuntime().then((rt) => rt.flush()).catch(() => {});
    leaveLocalMode();
    await resetLocalRuntime();
    userRef.current = null;
    setUser(null);
    await clearSessionData();
    return checkStatus();
  }, [checkStatus]);

  const handleTakeover = useCallback(async (action) => {
    if (action?.mode === 'server') return handleServerSelected(action.serverId);
    const profile = action?.profile ? { id: action.profile.id, name: action.profile.username } : getLocalProfile();
    return openLocal(profile);
  }, [handleServerSelected, openLocal]);

  const handleLogout = useCallback(async () => {
    if (isLocalMode()) return closeLocal();
    const current = userRef.current;
    loggingOut.current = true;
    runSeq.current++;
    // a backup download of this session must not complete after the logout
    cancelAllDownloads();
    try {
      // quick buys still in their undo window are sent (or queued) while the session is valid
      if (current) await runBeforeLogout();
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      let queued = 0;
      if (current) {
        try {
          const { getOutbox, outboxScope } = await loadOutbox();
          const outbox = getOutbox();
          if (!current.offline && online) await outbox.flush(outboxScope(current.id), { force: true });
          queued = outbox.count(outboxScope(current.id));
        } catch (_) { /* stays queued */ }
      }
      // Set before the request: if it never arrives, the next start sends it again instead of reusing the session
      markLogoutPending();
      const done = isAppMode() ? await flushPendingLogout() : await postLogout();
      if (done) clearLogoutPending();
      await clearSessionData();
      setNotice(!done ? MESSAGES.logoutPending : (queued > 0 ? OUTBOX_QUEUED : null));
      setLastSync(null);
      userRef.current = null;
      setUser(null);
    } finally {
      loggingOut.current = false;
    }
  }, [closeLocal]);

  const app = isAppMode();
  let content;
  if (loading) {
    content = <LoadingScreen />;
  } else if (needsSetup && !localMode && !(isAppMode() && !activeServer)) {
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
        {app && <DeepLinkListener />}
        {app && <ScrollTopAfterSetup />}
        <ApiKeysMenuListener user={user} />
        {user?.offline && <OfflineBanner lastSync={lastSync} />}
        <RouteBoundary>
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/login" element={<LoginRoute user={user} onLogin={handleLogin} notice={notice} onRetry={app ? checkStatus : undefined} hasServer={!app || Boolean(activeServer)} />} />
              {app && (
                <Route
                  path="/server"
                  element={localMode
                    ? <LocalScreen user={user} notice={notice} onOpen={handleOpenLocal} onReplaced={handleLocalReplaced} onTakeover={handleTakeover} onLeave={handleLeaveLocal} onSwitchProfile={handleSwitchProfile} />
                    : <ServerScreen user={user} onSelect={handleServerSelected} onUseLocal={handleOpenLocal} onTakeover={handleTakeover} />}
                />
              )}
              {app && <Route path="/lokal" element={<LocalSetup user={localMode ? user : null} onStart={handleStartLocal} />} />}
              <Route path="/" element={<RequireAuth user={user}><div className={user?.offline ? 'max-sm:pb-[calc(env(safe-area-inset-bottom)+4rem)]' : 'max-sm:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]'}><Dashboard user={user} onLogout={handleLogout} onLocalReplaced={handleLocalReplaced} /></div></RequireAuth>} />
              <Route path="/manga/:id" element={<RequireAuth user={user}><MangaDetail user={user} onUnauthorized={handleUnauthorized} /></RequireAuth>} />
              <Route path="*" element={<Navigate to={user ? '/' : (app && (localMode || !activeServer) ? '/server' : '/login')} replace />} />
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
