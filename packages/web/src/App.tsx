import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import PairingScreen from './PairingScreen';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import { SessionsProvider } from './SessionsProvider';
import { clearStoredCredentials, getStoredCredentials } from './storage';

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
            element={<SessionDetail token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
        </Routes>
      </BrowserRouter>
    </SessionsProvider>
  );
}
