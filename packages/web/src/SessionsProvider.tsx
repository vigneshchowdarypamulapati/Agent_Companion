import { createContext, useContext, type ReactNode } from 'react';
import { useSessionsStore, type UseSessionsStoreResult } from './use-sessions-store';

const SessionsContext = createContext<UseSessionsStoreResult | undefined>(undefined);

export interface SessionsProviderProps {
  token: string;
  onUnauthorized: () => void;
  children: ReactNode;
}

export function SessionsProvider({ token, onUnauthorized, children }: SessionsProviderProps) {
  const store = useSessionsStore(token, onUnauthorized);
  return <SessionsContext.Provider value={store}>{children}</SessionsContext.Provider>;
}

export function useSessions(): UseSessionsStoreResult {
  const context = useContext(SessionsContext);
  if (!context) {
    throw new Error('useSessions must be used within a SessionsProvider');
  }
  return context;
}
