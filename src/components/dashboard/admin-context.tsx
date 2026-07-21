"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  createdAt?: string;
}

interface SessionContextValue {
  user: SessionUser;
  sessionFetch: (path: string, init?: RequestInit) => Promise<Response>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  isAdmin: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function withJsonHeaders(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
      if (response.ok) {
        const payload = await response.json();
        setUser(payload.user);
        return;
      }
      setUser(null);
      const status = await fetch("/api/bootstrap/status", { cache: "no-store" }).then((result) => result.json()).catch(() => null);
      router.replace(status?.initialized ? `/login?next=${encodeURIComponent(pathname)}` : "/setup");
    } finally {
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSession(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshSession]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
    setUser(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  const sessionFetch = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: withJsonHeaders(init),
      cache: "no-store",
    });
    if (response.status === 401) {
      setUser(null);
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    return response;
  }, [pathname, router]);

  const value = useMemo<SessionContextValue | null>(() => user ? ({
    user,
    sessionFetch,
    logout,
    refreshSession,
    isAdmin: user.role === "ADMIN",
  }) : null, [logout, refreshSession, sessionFetch, user]);

  if (loading || !value) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#fafafa]">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在验证会话
        </div>
      </main>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}

// 暂时保留旧名称，现有页面可渐进迁移；底层已完全使用 HttpOnly 会话。
export const AdminProvider = SessionProvider;
export function useAdmin() {
  const session = useSession();
  return { ...session, adminFetch: session.sessionFetch, lock: session.logout };
}
