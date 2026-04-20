import { useState } from "react";
import { checkForUpdate, getCurrentVersion, openDownloadPage } from "../utils/updateChecker";
import { UpdateModal } from "../components/UpdateModal";
import type { UpdateInfo } from "../utils/updateChecker";

interface AboutProps {
  onToast?: (type: "success" | "error" | "warning" | "info", message: string, duration?: number) => void;
}

// SVG Icons
const icons = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
  coffee: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <path d="M18 8h1a4 4 0 0 1 0 8h-1"/>
      <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/>
      <line x1="6" y1="1" x2="6" y2="4"/>
      <line x1="10" y1="1" x2="10" y2="4"/>
      <line x1="14" y1="1" x2="14" y2="4"/>
    </svg>
  ),
  qrcode: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <rect x="3" y="3" width="7" height="7"/>
      <rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="14" height="14">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </svg>
  ),
};

export function About({ onToast }: AboutProps) {
  const [showQrModal, setShowQrModal] = useState<string | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  // 处理赞助按钮点击
  const handleSponsorClick = (type: string) => {
    setShowQrModal(type);
  };

  // 关闭二维码弹窗
  const closeQrModal = () => {
    setShowQrModal(null);
  };

  // 复制 QQ 群号
  const handleCopyQQ = () => {
    navigator.clipboard.writeText("894356872").then(() => {
      onToast?.("success", "已复制 QQ 群号: 894356872", 2000);
    });
  };

  // 获取二维码图片路径
  const getQrImage = (type: string) => {
    switch (type) {
      case "wechat":
        return "./weixin.jpg";
      case "alipay":
        return "./zfb.jpg";
      case "qq":
        return "./qq.jpg";
      default:
        return "";
    }
  };

  // 获取二维码标题
  const getQrTitle = (type: string) => {
    switch (type) {
      case "wechat":
        return "微信支付";
      case "alipay":
        return "支付宝";
      case "qq":
        return "QQ 红包";
      default:
        return "";
    }
  };

  // 检查更新
  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    try {
      const update = await checkForUpdate();
      
      if (update) {
        setUpdateInfo(update);
        setUpdateModalOpen(true);
      } else {
        onToast?.("success", "当前已是最新版本", 2000);
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // 执行下载
  const handleDoDownload = async () => {
    try {
      if (updateInfo?.downloadUrl) {
        await openDownloadPage(updateInfo.downloadUrl);
        onToast?.("success", "已打开下载页面", 2000);
      }
    } catch (error) {
      onToast?.("error", "打开下载页面失败", 2000);
      throw error;
    }
  };

  return (
    <div className="about-page">
      <div className="about-card">
        {/* 头部横排 */}
        <div className="about-header">
          <img src="./logo.png" alt="Trae账号管理" className="about-logo" />
          <div className="about-header-text">
            <div className="title-row">
              <h1 className="about-title">Trae账号管理</h1>
              <span className="version">v{getCurrentVersion()}</span>
            </div>
          </div>
          <button
            className="check-update-btn"
            onClick={handleCheckUpdate}
            disabled={isCheckingUpdate}
            title="检查更新"
          >
            {isCheckingUpdate ? (
              <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 21h5v-5"/>
              </svg>
            )}
            {isCheckingUpdate ? "检查中..." : "检查更新"}
          </button>
        </div>
        
        {/* 说明和信息横向排列 */}
        <div className="about-intro-section">
          <p className="about-desc">
            这是一款专为 Trae IDE 用户打造的多账号高效管理工具。通过本工具，您可以轻松管理多个 Trae 账号，一键切换账号，实时查看使用量，让您的 Trae IDE 使用体验更加便捷！基于
            <a
              href="https://github.com/S-Trespassing/Trae账号管理"
              target="_blank"
              rel="noopener noreferrer"
              className="original-link"
            >
              原作者项目
            </a>
            进行二次开发，原作者已不再维护。
          </p>
          
          <div className="about-info">
            <a 
              href="https://github.com/HHH9201/Trae-cc.git" 
              target="_blank" 
              rel="noopener noreferrer"
              className="github-link"
            >
              <span className="label">GitHub</span>
              <span className="value">HHH9201/Trae-cc</span>
            </a>
          </div>
        </div>

        {/* 分割线 */}
        <div className="about-divider"></div>

        {/* 售后支持 */}
        <div className="about-support-section">
          <div className="about-support-header">
            <div className="about-support-icon">{icons.chat}</div>
            <div className="about-support-title">售后支持</div>
          </div>
          <div className="about-support-content">
            <p>遇到问题？加入 QQ 群 894356872 获取帮助</p>
          </div>
          <div className="about-support-actions">
            <button
              onClick={() => setShowQrModal("qqgroup")}
              className="about-support-btn copy"
              title="查看群二维码"
            >
              {icons.qrcode}
              复制群号
            </button>
            <a
              href="http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=894356872"
              target="_blank"
              rel="noopener noreferrer"
              className="about-support-btn qq"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6zm4 4h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              加入 QQ 群
            </a>
          </div>
        </div>

        {/* 赞助支持 */}
        <div className="about-sponsor-section">
          <div className="about-sponsor-header">
            <div className="about-sponsor-icon">{icons.coffee}</div>
            <div className="about-sponsor-title">赞助支持</div>
          </div>
          <div className="about-sponsor-content">
            <p>如果这个项目对你有帮助，可以考虑赞助支持开发者</p>
          </div>
          <div className="about-sponsor-actions">
            <button 
              className="about-sponsor-btn wechat"
              onClick={() => handleSponsorClick("wechat")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8.5 13.5A1.5 1.5 0 1 0 7 12a1.5 1.5 0 0 0 1.5 1.5zm6.5 0a1.5 1.5 0 1 0-1.5-1.5 1.5 1.5 0 0 0 1.5 1.5z"/>
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-2.21.9-4.21 2.35-5.65L12 12V4c4.41 0 8 3.59 8 8s-3.59 8-8 8z"/>
              </svg>
              微信支付
            </button>
            <button 
              className="about-sponsor-btn alipay"
              onClick={() => handleSponsorClick("alipay")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6zm4 4h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              支付宝
            </button>
            <button 
              className="about-sponsor-btn qq"
              onClick={() => handleSponsorClick("qq")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6zm4 4h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              QQ 红包
            </button>
          </div>
        </div>
        
        {/* 页脚 */}
        <div className="about-footer">
          Made with {icons.heart} by HJH · MIT License
        </div>
      </div>

      {/* 更新弹窗 */}
      <UpdateModal
        isOpen={updateModalOpen}
        updateInfo={updateInfo}
        onClose={() => setUpdateModalOpen(false)}
        onDownload={handleDoDownload}
      />

      {/* 二维码弹窗 */}
      {showQrModal && (
        <div className="qr-modal-overlay" onClick={closeQrModal}>
          <div className="qr-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="qr-modal-header">
              <h3>{showQrModal === "qqgroup" ? "QQ 群: 894356872" : getQrTitle(showQrModal)}</h3>
              {showQrModal === "qqgroup" && (
                <button 
                  className="qr-modal-copy-btn"
                  onClick={handleCopyQQ}
                  title="复制群号"
                >
                  {icons.copy}
                  复制群号
                </button>
              )}
              <button className="qr-modal-close" onClick={closeQrModal} aria-label="关闭">
                {icons.close}
              </button>
            </div>
            <div className="qr-modal-body">
              <img 
                src={showQrModal === "qqgroup" ? "./qqq.jpg" : getQrImage(showQrModal)} 
                alt={showQrModal === "qqgroup" ? "QQ群二维码" : `${getQrTitle(showQrModal)}二维码`}
                className="qr-image"
              />
              <p className="qr-hint">
                {showQrModal === "qqgroup" ? "扫描二维码加入 QQ 群" : "扫描二维码进行支付"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
