import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router';
import PairingScreen from './PairingScreen';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import SettingsScreen from './SettingsScreen';
import { SessionsProvider } from './SessionsProvider';
import { clearStoredCredentials, getStoredCredentials } from './storage';

// React Router reuses the same SessionDetail instance across an id-only
// navigation (/sessions/A -> /sessions/B), which would let stale
// events/lastSeq/historyLoaded state from the old session persist for a
// moment after `summary` (read fresh from context) has already flipped to
// the new one. Keying on `id` forces a remount on every id change.
function KeyedSessionDetail(props: { token: string; onUnauthorized: () => void }) {
  const { id } = useParams<{ id: string }>();
  return <SessionDetail key={id} {...props} />;
}

export default function App() {
  const [credentials, setCredentials] = useState(() => getStoredCredentials());

  if (!credentials) {
    return <PairingScreen onPaired={() => setCredentials(getStoredCredentials())} />;
  }

  const handleUnauthorized = () => {
    clearStoredCredentials();
    setCredentials(undefined);
  };

  return (
    <SessionsProvider token={credentials.token} onUnauthorized={handleUnauthorized}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<SessionList />} />
          <Route
            path="/sessions/:id"
            element={<KeyedSessionDetail token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
          <Route
            path="/settings"
            element={<SettingsScreen token={credentials.token} onUnpaired={handleUnauthorized} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionsProvider>
  );
}
