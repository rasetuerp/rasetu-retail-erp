import { createContext, useContext, useState, useCallback, type ReactNode, createElement } from 'react';

// Shared session context — infrastructure, not a page (same exemption as api.ts).

export type SessionUser = { id: string; name: string; username: string; role: 'ADMIN' | 'STAFF' | 'SUPER_ADMIN'; permissions?: string[] | null };
export type Session = { companyId: string; token: string; user: SessionUser };

const STORAGE_KEY = 'rasetu-session';

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

type SessionContextValue = {
  session: Session | null;
  setSession: (session: Session | null) => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(() => loadStoredSession());

  const setSession = useCallback((next: Session | null) => {
    setSessionState(next);
    if (next) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  return createElement(SessionContext.Provider, { value: { session, setSession } }, children);
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
