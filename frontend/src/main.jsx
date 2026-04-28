import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

function HeartbeatWrapper() {
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/desktop/heartbeat').catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);
  
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HeartbeatWrapper />
  </StrictMode>,
)

