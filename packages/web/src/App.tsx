import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router';
import { SignedIn, SignedOut, SignIn, useClerk } from '@clerk/clerk-react';
import BrowserRegistrationGate from './BrowserRegistrationGate';
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
  const { signOut } = useClerk();
  const [credentials, setCredentials] = useState(() => getStoredCredentials());

  // Clearing only the companion device token would leave the browser still
  // Clerk-signed-in, which would silently re-register a brand new device
  // the instant this renders again — defeating the point of unpairing. This
  // is what actually reproduces the old "unpair = logout" behavior now that
  // Clerk holds a second, independent layer of credential.
  const handleUnauthorized = () => {
    clearStoredCredentials();
    setCredentials(undefined);
    void signOut();
  };

  if (!credentials) {
    return (
      <>
        <SignedOut>
          <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-4">
            <SignIn />
          </div>
        </SignedOut>
        <SignedIn>
          <BrowserRegistrationGate onRegistered={setCredentials} />
        </SignedIn>
      </>
    );
  }

  return (
    <SessionsProvider token={credentials.token} onUnauthorized={handleUnauthorized}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={<SessionList token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
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
