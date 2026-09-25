import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './Login';
import Dashboard from './Dashboard';
import MangaDetail from './MangaDetail';
import Setup from './Setup';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const setupRes = await fetch('/api/setup/status');
      const setupData = await setupRes.json();
      if (setupData.needsSetup) {
        setNeedsSetup(true);
        setLoading(false);
        return;
      }
      
      const authRes = await fetch('/api/auth/me');
      if (authRes.ok) {
        const authData = await authRes.json();
        setUser(authData.user);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="flex h-screen items-center justify-center">Loading...</div>;

  if (needsSetup) {
    return <Setup onComplete={() => { setNeedsSetup(false); checkStatus(); }} />;
  }

  return (
    <Router>
      <Routes>
        <Route path="/login" element={!user ? <Login onLogin={checkStatus} /> : <Navigate to="/" />} />
        <Route path="/" element={user ? <Dashboard user={user} onLogout={() => { fetch('/api/auth/logout', {method:'POST'}); setUser(null); }} /> : <Navigate to="/login" />} />
        <Route path="/manga/:id" element={user ? <MangaDetail user={user} /> : <Navigate to="/login" />} />
      </Routes>
    </Router>
  );
}

export default App;
