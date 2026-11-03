import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { NotifyProvider } from './lib/notify.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <NotifyProvider>
      <App />
    </NotifyProvider>
  </StrictMode>,
)

