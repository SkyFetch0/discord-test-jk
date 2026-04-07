import React, { useEffect, useState } from "react";
import { Spinner } from "../components";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  submitting?: boolean;
  initialReason?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function PauseReasonModal({
  title,
  message,
  confirmLabel = "Durdur",
  cancelLabel = "İptal",
  placeholder = "İsteğe bağlı açıklama",
  submitting = false,
  initialReason = "",
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState(initialReason);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, submitting]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9100,
        background: "rgba(0,0,0,0.62)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "fadeIn .15s ease both",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: "94vw",
          background: "var(--bg-3)",
          border: "1px solid var(--gb1)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--sh-float)",
          animation: "scaleIn .18s ease both",
        }}
      >
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--gb1)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)" }}>{title}</div>
            <div style={{ fontSize: 12, color: "var(--t3)", marginTop: 4, lineHeight: 1.55 }}>{message}</div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onCancel} disabled={submitting} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 6 }}>
              Durdurma Sebebi
            </label>
            <textarea
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={placeholder}
              rows={4}
              disabled={submitting}
              style={{ width: "100%", resize: "vertical", boxSizing: "border-box", minHeight: 110 }}
              autoFocus
            />
            <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 8 }}>
              Boş bırakabilirsin. Sebep sadece görünürlük ve audit için saklanır.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>{cancelLabel}</button>
            <button className="btn btn-primary btn-sm" onClick={() => onConfirm(reason.trim())} disabled={submitting}>
              {submitting ? <Spinner /> : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
