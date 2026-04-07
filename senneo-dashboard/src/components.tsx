import React, { useState } from "react";
import { fmtTs, useToasts } from "./hooks";
import type { RateLimitEntry, Toast } from "./types";
import { Icon as UnifiedIcon } from "./icons";

/**
 * Backward-compatible Icon bridge.
 * Existing code uses <Icon.grid />, <Icon.search />, etc.
 * Each key delegates to the centralized Icon system (custom or Lucide).
 */
export const Icon = {
  grid:    () => <UnifiedIcon name="grid" />,
  clock:   () => <UnifiedIcon name="clock" />,
  search:  () => <UnifiedIcon name="search-custom" />,
  db:      () => <UnifiedIcon name="db" />,
  account: () => <UnifiedIcon name="account" />,
  proxy:   () => <UnifiedIcon name="globe" />,
  live:    () => <UnifiedIcon name="live" />,
  chart:   () => <UnifiedIcon name="chart" />,
  close:   () => <UnifiedIcon name="close-x" />,
  plus:    () => <UnifiedIcon name="plus-icon" />,
  trash:   () => <UnifiedIcon name="trash" size={16} />,
  refresh: () => <UnifiedIcon name="refresh-cw" />,
  users:   () => <UnifiedIcon name="users-custom" />,
  hash:    () => <UnifiedIcon name="hash" />,
  widget:  () => <UnifiedIcon name="widget" />,
  alert:   () => <UnifiedIcon name="alert-triangle" />,
  server:  () => <UnifiedIcon name="server" />,
};

export const Spinner = () => <div className="spin" />;
export const Empty = ({ text = "Veri yok" }: { text?: string }) =>
  <div className="empty">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={0.3}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    {text}
  </div>;

export const StatusTag = ({ complete, msgsPerSec, errors, totalScraped }: { complete: boolean; msgsPerSec: number; errors: string[]; totalScraped: number }) => {
  if (complete)         return <span className="tag tag-done">✓ Bitti</span>;
  if (errors?.length)  return <span className="tag tag-error">✕ Hata</span>;
  if (msgsPerSec > 0)  return <span className="tag tag-active">● Aktif</span>;
  if (totalScraped > 0) return <span className="tag tag-waiting">◌ Bekliyor</span>;
  return <span className="tag tag-queued">○ Sırada</span>;
};

export const ProgressBar = ({ value, complete }: { value: number; complete: boolean }) =>
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <div className="prog" style={{ flex: 1, minWidth: 60 }}>
      <div className={`prog-bar${complete ? " done" : ""}`} style={{ width: `${value}%` }} />
    </div>
    {value > 0 && <span style={{ fontSize: 9, color: "var(--t3)", minWidth: 26, textAlign: "right", fontFamily: "var(--mono)" }}>{value}%</span>}
  </div>;

export const RateLimitLog = ({ log }: { log: RateLimitEntry[] }) => {
  if (!log.length) return <Empty text="Rate limit yok" />;
  return <div>{[...log].reverse().map((r, i) =>
    <div key={i} className="rl-row">
      <span className="rl-ts">{fmtTs(r.ts)}</span>
      <span className="rl-ch">{r.channelId}</span>
      <span className="rl-wait">+{r.waitMs}ms</span>
    </div>
  )}</div>;
};

export const DataTable = ({ rows }: { rows: Record<string, unknown>[] }) => {
  if (!rows?.length) return <Empty />;
  const cols = Object.keys(rows[0]);
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) =>
          <tr key={i}>{cols.map(c =>
            <td key={c}><div className="cell-clip mono" style={{ color: "var(--t2)" }}>
              {row[c] == null ? <span style={{ color: "var(--t4)" }}>null</span> : String(row[c])}
            </div></td>
          )}</tr>
        )}</tbody>
      </table>
    </div>
  );
};

/* ── Toast UI ── */
const TOAST_ICONS = {
  success: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>,
  error:   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>,
  info:    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
};

function ToastItem({ toast }: { toast: Toast & { id: string } }) {
  return (
    <div className={`toast ${toast.type}`}>
      <span className="toast-icon">{TOAST_ICONS[toast.type]}</span>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.msg && <div className="toast-msg">{toast.msg}</div>}
      </div>
      {toast.onAction && toast.actionLabel && (
        <button
          className="btn btn-secondary btn-xs"
          style={{ flexShrink: 0, pointerEvents: 'auto' }}
          onClick={toast.onAction}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}