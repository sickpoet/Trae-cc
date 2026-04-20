import { useEffect, useState } from "react";
import type { ErrorCode } from "../types/errorCodes";
import { ERROR_CONFIG_MAP } from "../types/errorCodes";
import "./ErrorModal.css";

interface ErrorModalProps {
  isOpen: boolean;
  code: ErrorCode;
  message?: string;
  onClose: () => void;
  onRetry?: () => void;
}

// 可重试的错误码
const RETRYABLE_ERRORS: ErrorCode[] = ["NETWORK_ERROR", "SERVER_ERROR", "RATE_LIMITED"];

function isRetryableError(code: ErrorCode): boolean {
  return RETRYABLE_ERRORS.includes(code);
}

export function ErrorModal({ isOpen, code, message, onClose, onRetry }: ErrorModalProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isShaking, setIsShaking] = useState(false);

  const errorInfo = ERROR_CONFIG_MAP[code] || ERROR_CONFIG_MAP["SERVER_ERROR"];
  const displayMessage = message || errorInfo.message;

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setIsShaking(true);
      const timer = setTimeout(() => setIsShaking(false), 500);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => setIsVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isVisible && !isOpen) return null;

  const canRetry = isRetryableError(code) && onRetry;

  const getIcon = () => {
    switch (errorInfo.icon) {
      case "limit":
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        );
      case "empty":
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        );
      case "expired":
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        );
      case "success":
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        );
      default:
        return (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        );
    }
  };

  return (
    <div className={`error-modal-overlay ${isOpen ? "visible" : ""}`} onClick={onClose}>
      <div
        className={`error-modal-content ${isOpen ? "visible" : ""} ${isShaking ? "shake" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="error-modal-close" onClick={onClose}>
          ×
        </button>

        <div className={`error-icon ${errorInfo.icon}`}>{getIcon()}</div>

        <h3 className="error-modal-title">{errorInfo.title}</h3>

        <p className="error-modal-message">{displayMessage}</p>

        {errorInfo.description && (
          <p className="error-modal-description">{errorInfo.description}</p>
        )}

        <div className="error-modal-actions">
          {canRetry ? (
            <>
              <button
                className="error-modal-btn primary"
                onClick={() => {
                  onClose();
                  onRetry();
                }}
              >
                重试
              </button>
              <button className="error-modal-btn" onClick={onClose} style={{ marginLeft: "12px" }}>
                取消
              </button>
            </>
          ) : (
            <button className="error-modal-btn primary" onClick={onClose}>
              知道了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
