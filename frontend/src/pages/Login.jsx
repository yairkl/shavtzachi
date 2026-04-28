import React, { useEffect, useState } from 'react';

export default function Login({ authStatus, authError }) {
  const [loading, setLoading] = useState(false);

  const isPermissionDenied = authStatus?.reason === 'permission_denied';
  const sheetId = authStatus?.sheet_id;
  const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : null;

  const handleLogin = () => {
    setLoading(true);
    // Navigate to backend auth login — it will redirect to Google
    window.location.href = '/api/auth/login';
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden"
         style={{ background: 'hsl(224, 71%, 4%)' }}>

      {/* Ambient glow blobs */}
      <div className="absolute inset-0 pointer-events-none">
        <div style={{
          position: 'absolute', top: '15%', left: '20%', width: 480, height: 480,
          borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(220,90%,55%,0.18) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
        <div style={{
          position: 'absolute', bottom: '15%', right: '15%', width: 380, height: 380,
          borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(260,80%,60%,0.14) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
      </div>

      {/* Card */}
      <div className="relative z-10 flex flex-col items-center gap-8 px-10 py-12 rounded-2xl"
           style={{
             background: 'rgba(26, 31, 46, 0.6)',
             backdropFilter: 'blur(20px)',
             border: '1px solid hsl(216, 34%, 17%)',
             boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
             minWidth: 380,
             maxWidth: 440,
           }}>

        {/* Icon */}
        <div style={{
          width: 72, height: 72, borderRadius: 20,
          background: 'linear-gradient(135deg, hsl(220,80%,55%), hsl(260,75%,60%))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 32px hsla(220,80%,55%,0.35)',
          fontSize: 32,
        }}>
          🗂️
        </div>

        {/* Title */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-2"
              style={{ letterSpacing: '-0.02em' }}>
            Shavtzachi
          </h1>
          <p className="text-sm" style={{ color: 'hsl(215, 16%, 57%)' }}>
            Sign in with your Google account to connect<br />to your scheduling spreadsheets.
          </p>
        </div>

        {/* Error */}
        {(authError || isPermissionDenied) && (
          <div className="w-full flex flex-col gap-3">
            <div className="w-full px-4 py-3 rounded-lg text-sm text-center"
                 style={{ 
                   background: isPermissionDenied ? 'hsla(35,100%,50%,0.15)' : 'hsla(0,63%,31%,0.3)', 
                   border: isPermissionDenied ? '1px solid hsla(35,100%,50%,0.4)' : '1px solid hsla(0,63%,50%,0.4)', 
                   color: isPermissionDenied ? 'hsl(35,100%,75%)' : 'hsl(0,80%,75%)' 
                 }}>
              {isPermissionDenied ? (
                <>
                  <div className="font-bold mb-1">Access Denied</div>
                  <div className="opacity-80">You don't have permission to access the spreadsheet.</div>
                </>
              ) : (
                decodeURIComponent(authError).replace(/\+/g, ' ')
              )}
            </div>

            {isPermissionDenied && sheetUrl && (
              <a 
                href={sheetUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="w-full py-2 rounded-lg text-xs font-medium text-center transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'hsl(215, 20%, 70%)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Open Spreadsheet to Request Access ↗
              </a>
            )}
          </div>
        )}

        {/* Sign in button */}
        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            padding: '12px 24px',
            borderRadius: 12,
            background: loading
              ? 'rgba(255,255,255,0.06)'
              : 'linear-gradient(135deg, hsl(220,80%,55%), hsl(260,75%,60%))',
            border: 'none',
            color: 'white',
            fontWeight: 600,
            fontSize: 15,
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: loading ? 'none' : '0 4px 20px hsla(220,80%,55%,0.4)',
          }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
        >
          {loading ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   style={{ animation: 'spin 1s linear infinite' }}>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" opacity="0.25"/>
                <path d="M21 12a9 9 0 00-9-9"/>
              </svg>
              Redirecting to Google…
            </>
          ) : (
            <>
              {/* Google "G" */}
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </>
          )}
        </button>

        <p className="text-xs text-center" style={{ color: 'hsl(215, 16%, 40%)' }}>
          Your data stays in your own Google Sheets.
        </p>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
