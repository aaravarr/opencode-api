"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "./admin-context";

export function useAdminResource<T>(path: string) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch(path);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || payload?.message || `请求失败 (${response.status})`);
      setData(payload as T);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }, [adminFetch, path]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  return { data, loading, error, refresh, setData };
}
