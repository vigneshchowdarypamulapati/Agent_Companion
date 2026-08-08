import { useState } from 'react';
import PairingScreen from './PairingScreen';
import Dashboard from './Dashboard';
import { clearStoredCredentials, getStoredCredentials } from './storage';

export default function App() {
  const [credentials, setCredentials] = useState(() => getStoredCredentials());

  if (!credentials) {
    return <PairingScreen onPaired={() => setCredentials(getStoredCredentials())} />;
  }

  return (
    <Dashboard
      token={credentials.token}
      onUnauthorized={() => {
        clearStoredCredentials();
        setCredentials(undefined);
      }}
    />
  );
}
