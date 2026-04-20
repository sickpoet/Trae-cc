import type { UpdateInfo } from "../utils/updateChecker";

import { openUrl } from "@tauri-apps/plugin-opener";

interface UpdateModalProps {
  isOpen: boolean;
  updateInfo: UpdateInfo | null;
  onClose: () => void;
  onDownload: () => void;
}

export function UpdateModal({ isOpen, updateInfo, onClose, onDownload }: UpdateModalProps) {
  if (!isOpen || !updateInfo) return null;

  const handleDownload = () => {
    onDownload();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ backdropFilter: 'blur(16px)', backgroundColor: 'rgba(0,0,0,0.3)' }}>
      <div 
        className="modal-content update-modal" 
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '520px',
          width: '90%',
          padding: '0',
          overflow: 'hidden',
          border: '1px solid rgba(255, 255, 255, 0.5)',
          boxShadow: '0 30px 60px -12px rgba(0, 0, 0, 0.15), 0 18px 36px -18px rgba(0, 0, 0, 0.1)',
          background: 'rgba(255, 255, 255, 0.85)',
          borderRadius: '32px',
          animation: 'modal-pop-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Decorative Top Glow */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '100%',
          height: '4px',
          background: 'var(--gradient-accent)',
        }} />

        <div style={{
          padding: '36px 32px 24px',
          textAlign: 'left',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: '24px',
        }}>
          {/* Decorative Top Glow */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '4px',
            background: 'var(--gradient-accent)',
          }} />

          {/* Main Icon with floating effect */}
          <div className="update-icon" style={{
            width: '64px',
            height: '64px',
            flexShrink: 0,
            background: 'var(--gradient-accent)',
            borderRadius: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            boxShadow: '0 12px 24px -6px rgba(102, 126, 234, 0.4)',
            position: 'relative',
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="28" height="28">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 21h5v-5"/>
            </svg>
            {/* Tiny Pulse Dot */}
            <div style={{
              position: 'absolute',
              top: '-2px',
              right: '-2px',
              width: '10px',
              height: '10px',
              background: '#4ade80',
              borderRadius: '50%',
              border: '2px solid #fff',
              boxShadow: '0 0 8px rgba(74, 222, 128, 0.5)',
            }} />
          </div>

          <div style={{ flex: 1 }}>
              <h2 style={{ fontSize: '20px', fontWeight: 800, color: '#1a202c', margin: 0, letterSpacing: '-0.025em' }}>
                系统更新 v1.0.7
              </h2>
              <p style={{ fontSize: '13px', color: '#718096', marginTop: '6px', lineHeight: '1.5', margin: '6px 0 0' }}>
                发现更稳定、更强大的 Trae 助手，建议立即更新。
              </p>
            </div>
        </div>

        <div className="update-modal-body" style={{ padding: '0 32px 32px', margin: 0 }}>
          {/* Integrated Version Progress Display */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(0, 0, 0, 0.03)',
            padding: '16px 24px',
            borderRadius: '20px',
            marginBottom: '32px',
            position: 'relative',
          }}>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '11px', color: '#a0aec0', fontWeight: 700, textTransform: 'uppercase', marginBottom: '2px' }}>当前版本</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#4a5568' }}>{updateInfo.currentVersion}</div>
            </div>
            
            {/* Animated Connector */}
            <div style={{ 
              flex: 1, 
              height: '2px', 
              background: 'linear-gradient(90deg, #e2e8f0 0%, var(--accent) 50%, #e2e8f0 100%)', 
              margin: '0 20px',
              borderRadius: '1px',
              opacity: 0.6
            }} />

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '2px' }}>最新版本</div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--accent)' }}>{updateInfo.version}</div>
            </div>
          </div>

          {updateInfo.notes && (
            <div className="update-notes" style={{ margin: 0, textAlign: 'left' }}>
              <div 
                className="notes-content" 
                style={{ 
                  whiteSpace: 'pre-wrap', 
                  lineHeight: '1.8',
                  background: 'rgba(255, 255, 255, 0.5)',
                  padding: '24px',
                  borderRadius: '24px',
                  border: '1px solid rgba(0, 0, 0, 0.04)',
                  maxHeight: '220px',
                  fontSize: '14px',
                  color: '#4a5568',
                  overflowY: 'auto',
                }}
              >
                {updateInfo.notes || `🚀 v1.0.7 核心体验与稳定性升级：
• 极简美学重构：基于 Bento Style 重新设计更新弹窗，视觉更轻盈，信息层级更清晰。
• 外部链接修复：解决“关于”页面和“更新弹窗”中 QQ 群、GitHub 等链接点击无反应的问题。
• 全链路连接增强：启用 Rustls-TLS 后端，新增多个高可用 API 镜像端点，解决 401 错误导致的请求失败。
• 更新机制加固：增加多端点自动重试逻辑，确保在复杂网络环境下仍能稳定获取最新版本。
• 交互细节优化：优化弹窗弹出动画与按钮反馈，提升软件整体的“精致感”与流畅度。`}
              </div>
            </div>
          )}

          {/* Premium Action Buttons */}
          <div style={{ marginTop: '36px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '14px' }}>
              <button
                type="button"
                className="premium-btn github"
                onClick={handleDownload}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  padding: '16px',
                  borderRadius: '18px',
                  border: '1px solid #e2e8f0',
                  background: '#fff',
                  color: '#1a202c',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: '0 2px 4px rgba(0, 0, 0, 0.02)',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 10px 20px -10px rgba(0,0,0,0.1)';
                  e.currentTarget.style.borderColor = 'var(--accent)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.02)';
                  e.currentTarget.style.borderColor = '#e2e8f0';
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                GitHub
              </button>
              <button
                 type="button"
                 className="premium-btn qq"
                 onClick={async () => {
                   try {
                     await openUrl("http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=894356872");
                   } catch (e) {
                     console.error("打开 QQ 群链接失败:", e);
                   }
                 }}
                 style={{
                   flex: 1.2,
                   display: 'flex',
                   alignItems: 'center',
                   justifyContent: 'center',
                   gap: '10px',
                   padding: '16px',
                   borderRadius: '18px',
                   border: 'none',
                   background: 'var(--gradient-accent)',
                   color: '#fff',
                   fontSize: '14px',
                   fontWeight: 600,
                   cursor: 'pointer',
                   transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                   boxShadow: '0 8px 20px -4px rgba(102, 126, 234, 0.4)',
                 }}
                 onMouseOver={(e) => {
                   e.currentTarget.style.transform = 'translateY(-2px)';
                   e.currentTarget.style.boxShadow = '0 12px 28px -6px rgba(102, 126, 234, 0.5)';
                   e.currentTarget.style.filter = 'brightness(1.1)';
                 }}
                 onMouseOut={(e) => {
                   e.currentTarget.style.transform = 'translateY(0)';
                   e.currentTarget.style.boxShadow = '0 8px 20px -4px rgba(102, 126, 234, 0.4)';
                   e.currentTarget.style.filter = 'brightness(1)';
                 }}
               >
                 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                   <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                 </svg>
                 加入 QQ 群
               </button>
            </div>
            
            <button 
              type="button" 
              onClick={onClose}
              style={{
                width: 'fit-content',
                margin: '8px auto 0',
                padding: '10px 24px',
                borderRadius: '12px',
                border: 'none',
                background: 'transparent',
                color: '#a0aec0',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseOver={(e) => e.currentTarget.style.color = '#718096'}
              onMouseOut={(e) => e.currentTarget.style.color = '#a0aec0'}
            >
              稍后提醒
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
