import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Soldiers from './pages/Soldiers';
import Posts from './pages/Posts';
import Scheduler from './pages/Scheduler';
import Unavailability from './pages/Unavailability';

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scheduler" element={<Scheduler />} />
          <Route path="/soldiers" element={<Soldiers />} />
          <Route path="/posts" element={<Posts />} />
          <Route path="/unavailability" element={<Unavailability />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
