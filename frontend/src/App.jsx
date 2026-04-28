import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Soldiers from './pages/Soldiers';
import Posts from './pages/Posts';
import Scheduler from './pages/Scheduler';
import Unavailability from './pages/Unavailability';
import Login from './pages/Login';

function App() {
  const [authStatus, setAuthStatus] = useState({ authenticated: null, backend: null });
  const [loading, setLoading] = useState(true);


  useEffect(() => {
    fetch('/api/auth/status')
      .then(res => res.json())
      .then(data => {
        setAuthStatus(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Auth check failed:", err);
        setLoading(false);
      });

  }, []);

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

  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scheduler" element={<Scheduler />} />
          <Route path="/soldiers" element={<Soldiers />} />
          <Route path="/posts" element={<Posts />} />
          <Route path="/unavailability" element={<Unavailability />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
