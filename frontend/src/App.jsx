import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Soldiers from './pages/Soldiers';
import Posts from './pages/Posts';
import Scheduler from './pages/Scheduler';
import Unavailability from './pages/Unavailability';
import Settings from './pages/Settings';
import Setup from './pages/Setup';
import Login from './pages/Login';

import { getAuthStatus } from './services/api';
import { gsheetsService } from './services/gsheetsService';
import { onSessionEvent, requestToken } from './services/auth';
import { notify } from './lib/notify';

function App() {
  const [authStatus, setAuthStatus] = useState({ authenticated: null, backend: null });
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);


  useEffect(() => {
    getAuthStatus()
      .then(res => {
        setAuthStatus(res.data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Auth check failed:", err);
        setLoading(false);
      });

  }, []);

  useEffect(() => onSessionEvent((type) => {
    if (type === 'expired') setSessionExpired(true);
    if (type === 'refreshed') {
      gsheetsService.setAccessToken(localStorage.getItem('google_access_token'));
      setSessionExpired(false);
    }
  }), []);

  const reconnect = async () => {
    try {
      await requestToken({ interactive: true });
      notify.success('Reconnected to Google.');
    } catch (err) {
      notify.error(`Could not reconnect: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#020617] text-white font-medium">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-400 animate-pulse">Initialising application...</p>
        </div>
      </div>
    );
  }

  // Get auth error from URL if present
  const urlParams = new URLSearchParams(window.location.search);
  const authError = urlParams.get('auth_error');

  if (!authStatus.authenticated) {
    return <Login authStatus={authStatus} authError={authError} />;
  }

  const hasSheet = !!gsheetsService.getSpreadsheetId();
  if (!hasSheet) {
    return <Setup />;
  }

  return (
    <Router>
      {sessionExpired && (
        <div role="alert" className="fixed top-0 inset-x-0 z-[90] flex items-center justify-center gap-3 bg-amber-500/95 text-black text-sm font-medium px-4 py-2">
          Your Google session expired. Your work on this page is kept.
          <button onClick={reconnect} className="underline font-bold">Reconnect</button>
        </div>
      )}
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scheduler" element={<Scheduler />} />
          <Route path="/soldiers" element={<Soldiers />} />
          <Route path="/posts" element={<Posts />} />
          <Route path="/unavailability" element={<Unavailability />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
