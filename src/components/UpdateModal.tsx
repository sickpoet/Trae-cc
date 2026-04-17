import { useState } from "react";
import type { UpdateInfo } from "../utils/updateChecker";

interface UpdateModalProps {
  isOpen: boolean;
  updateInfo: UpdateInfo | null;
  onClose: () => void;
  onDownload: () => void;
}

export function UpdateModal({ isOpen, updateInfo, onClose, onDownload }: UpdateModalProps) {
  const [isOpening, setIsOpening] = useState(false);

  if (!isOpen || !updateInfo) return null;

  const handleDownload = async () => {
    setIsOpening(true);
    try {
      await onDownload();
    } catch {
      setIsOpening(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="update-modal-header">
          <div className="update-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="32" height="32">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 21h5v-5"/>
            </svg>
          </div>
          <h2>发现新版本</h2>
        </div>

        <div className="update-modal-body">
          <div className="version-info">
            <div className="version-row">
              <span className="version-label">当前版本:</span>
              <span className="version-current">{updateInfo.currentVersion}</span>
            </div>
            <div className="version-row">
              <span className="version-label">最新版本:</span>
              <span className="version-new">{updateInfo.version}</span>
            </div>
          </div>

          {updateInfo.notes && (
            <div className="update-notes">
              <h3>更新内容:</h3>
              <div className="notes-content">{updateInfo.notes}</div>
            </div>
          )}

          {isOpening && (
            <div className="download-progress">
              <div className="progress-spinner"></div>
              <span>正在打开下载页面...</span>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={isOpening}>
            稍后提醒
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleDownload}
            disabled={isOpening}
          >
            {isOpening ? "打开中..." : "前往下载"}
          </button>
        </div>
      </div>
    </div>
  );
}
