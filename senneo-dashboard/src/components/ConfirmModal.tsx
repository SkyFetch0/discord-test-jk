import React from "react";

interface Props {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "info";
  onConfirm: () => void;
  onCancel: () => void;
}

const VARIANT_STYLES: Record<string, { btn: string; accent: string }> = {
  danger:  { btn: "btn-danger",  accent: "var(--red)" },
  warning: { btn: "btn-primary", accent: "var(--orange)" },
  info:    { btn: "btn-primary", accent: "var(--blue)" },
};

export function ConfirmModal({
  title, message, detail, confirmLabel = "Onayla", cancelLabel = "Vazgec",
  variant = "danger", onConfirm, onCancel,
}: Props) {
  const vs = VARIANT_STYLES[variant] ?? VARIANT_STYLES.danger;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: "fadeIn .15s ease both",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: "var(--bg-3)", border: "1px solid var(--gb1)",
          borderRadius: "var(--r-xl)", padding: "24px 28px",
          minWidth: 340, maxWidth: 440,
          boxShadow: "var(--sh-float)",
          animation: "scaleIn .18s ease both",
        }}
      >
        {/* Title */}
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--t1)", marginBottom: 8, letterSpacing: "-0.3px" }}>
          {title}
        </div>

        {/* Message */}
        <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.6, marginBottom: detail ? 8 : 20 }}>
          {message}
        </div>

        {/* Detail (optional) */}
        {detail && (
          <div style={{
            fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)",
            background: "rgba(0,0,0,0.3)", borderRadius: "var(--r-sm)",
            padding: "8px 10px", marginBottom: 20, wordBreak: "break-all",
          }}>
            {detail}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={`btn ${vs.btn} btn-sm`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
