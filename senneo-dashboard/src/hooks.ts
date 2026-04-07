import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import type { ScraperSummary } from "./types";

/* ── SSE (lightweight summary only — no per-channel data) ── */
export function useSSE() {
  const [summary, setSummary] = useState<ScraperSummary | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let es: EventSource; let retry: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    function connect() {
      es = new EventSource("/live/stream");
      es.onopen = () => { setConnected(true); retryDelay = 1000; };
      es.onerror = () => {
        setConnected(false); es.close();
        const jitter = Math.random() * 1000;
        retry = setTimeout(connect, retryDelay + jitter);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data) as ScraperSummary;
          if ((d as any).status === "loading") return;
          setSummary(d);
          setConnected(true);
        } catch {}
      };
    }
    connect();
    return () => { es?.close(); clearTimeout(retry); };
  }, []);
  return { summary, connected };
}

/* ── Debounced value ── */
export function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/* ── useFetch (fixed — no infinite loop) ── */
export function useFetch<T>(fetcher: (() => Promise<T>) | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const load = useCallback(async () => {
    if (!fetcherRef.current) return;
    setLoading(true); setError(null);
    try { setData(await fetcherRef.current()); }
    catch (e) { setError(e instanceof Error ? e.message : "Error"); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

/* ── Keyboard ── */
export function useKeyboard(handlers: Record<string, () => void>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); handlers["cmd+k"]?.(); return; }
      if (isInput) return;
      const key = [e.ctrlKey && "ctrl", e.metaKey && "meta", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join("+");
      handlers[key]?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}

/* ── Interval ── */
export function useInterval(fn: () => void, ms: number, immediate = true) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    if (immediate) ref.current();
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
}

/* ── Count-up animation ── */
export function useCountUp(target: number, duration = 1200): number {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);
  const rafRef  = useRef<number>(0);
  useEffect(() => {
    const from = prevRef.current;
    const to   = target;
    prevRef.current = to;
    if (from === to) return;
    cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const step = (ts: number) => {
      const p = Math.min((ts - start) / duration, 1);
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p); // easeOutExpo
      setDisplay(Math.round(from + (to - from) * e));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return display;
}

/* ── Guild info cache ── */
export interface GuildInfo {
  id: string; name: string; icon: string | null;
  memberCount?: number; approximate_member_count?: number;
}

const guildCache = new Map<string, GuildInfo | null>();

export function useGuildInfo(guildId?: string, accIdx?: number, accountId?: string) {
  const [data, setData] = useState<GuildInfo | null>(() => guildId && guildCache.has(guildId) ? guildCache.get(guildId) ?? null : null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!guildId || (!accountId && accIdx == null)) return;
    if (guildCache.has(guildId)) { setData(guildCache.get(guildId) ?? null); return; }
    setLoading(true);
    fetch(`/accounts/guild/${guildId}/info?${accountId ? `accountId=${encodeURIComponent(accountId)}` : `accIdx=${accIdx}`}`)
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then((info: GuildInfo | null) => { guildCache.set(guildId, info); setData(info); })
      .finally(() => setLoading(false));
  }, [guildId, accIdx, accountId]);
  return { data, loading };
}

/* ── Toast system ── */
export interface Toast { id: string; type: 'success'|'error'|'info'; title: string; msg?: string; actionLabel?: string; onAction?: () => void }
type ToastCtx = { add: (t: Omit<Toast,'id'>) => void }

// Simple module-level event bus (no React context needed for this use)
const toastListeners: Array<(t: Toast) => void> = [];

export function addToast(t: Omit<Toast,'id'>) {
  const toast: Toast = { ...t, id: Math.random().toString(36).slice(2) };
  toastListeners.forEach(fn => fn(toast));
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const fn = (t: Toast) => {
      setToasts(p => [...p, t]);
      setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), 3500);
    };
    toastListeners.push(fn);
    return () => { const i = toastListeners.indexOf(fn); if (i !== -1) toastListeners.splice(i, 1); };
  }, []);
  return toasts;
}

/* ── Helpers ── */
export const fmt       = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString("tr-TR");
export const fmtTs     = (iso: string | null | undefined) => { if (!iso) return "—"; try { return new Date(iso).toLocaleTimeString("tr-TR"); } catch { return iso; } };
export const fmtDate   = (iso: string | null | undefined) => { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString("tr-TR", { month: "short", day: "numeric" }); } catch { return iso; } };
export const avatarColor   = (seed: string) => { const c = ["#0EA5E9","#30D158","#BF5AF2","#FF9F0A","#FF453A","#38BDF8","#0284C7","#5AC8FA"]; let h = 0; for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h); return c[Math.abs(h) % c.length]; };
export const avatarInitial = (name: string) => (name?.[0] ?? "?").toUpperCase();
export const discordIconUrl = (guildId: string, iconHash: string|null|undefined, size=64) => iconHash ? `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png?size=${size}` : null;
export const discordAvatarUrl = (userId?: string, hash?: string, size=80) => userId && hash ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=${size}` : null;
export const defaultAvatarUrl = (userId?: string) => { const idx = userId ? Math.abs(userId.split('').reduce((a,c) => a + c.charCodeAt(0), 0)) % 6 : 0; return `https://cdn.discordapp.com/embed/avatars/${idx}.png`; };