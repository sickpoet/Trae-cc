import { useEffect, useState } from "react";
import type { ErrorCode, ErrorConfig } from "../types/errorCodes";
import { ERROR_CONFIG_MAP } from "../types/errorCodes";
import "./ErrorModal.css";

interface ErrorModalProps {
  isOpen: boolean;
  errorCode: ErrorCode | null;
  customMessage?: string;
  onClose: () => void;
  onAction?: () => void;
}

// 图标组件
const ErrorIcon = ({ type }: { type: ErrorConfig["icon"] }) => {
  const icons = {
    limit: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
        <path d="M8 12h8" strokeLinecap="round" />
      </svg>
    ),
    empty: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
    expired: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
        <path d="M4 4l16 16" strokeLinecap="round" />
      </svg>
    ),
    error: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    success: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
  };

  return <div className={`error-icon ${type}`}>{icons[type]}</div>;
};

export function ErrorModal({
  isOpen,
  errorCode,
  customMessage,
  onClose,
  onAction,
}: ErrorModalProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setIsVisible(true), 10);
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  if (!isOpen || !errorCode) return null;

  const config = ERROR_CONFIG_MAP[errorCode];
  const displayMessage = customMessage || config.message;

  const handleAction = () => {
    if (onAction) {
      onAction();
    } else {
      onClose();
    }
  };

  return (
    <div
      className={`error-modal-overlay ${isVisible ? "visible" : ""}`}
      onClick={onClose}
    >
      <div
        className={`error-modal-content ${isVisible ? "visible" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="error-modal-close" onClick={onClose}>
          ×
        </button>

        <div className="error-modal-body">
          <ErrorIcon type={config.icon} />

          <h3 className="error-modal-title">{config.title}</h3>

          <p className="error-modal-message">{displayMessage}</p>

          {config.description && (
            <p className="error-modal-description">{config.description}</p>
          )}
        </div>

        <div className="error-modal-actions">
          <button className="error-modal-btn primary" onClick={handleAction}>
            {config.actionText || "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
