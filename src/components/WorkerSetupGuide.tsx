import { useState } from 'react';

interface WorkerSetupGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WorkerSetupGuide({ isOpen, onClose }: WorkerSetupGuideProps) {
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [showSql, setShowSql] = useState(true);

  if (!isOpen) return null;

  const workerCode = `export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    // 自动清理 5 分钟前数据
    await env.DB.prepare(\`DELETE FROM messages WHERE created_at < datetime('now', '-5 minute')\`).run();

    if (url.pathname === "/api/get-code") {
      const providedKey = url.searchParams.get("key");
      const targetEmail = url.searchParams.get("email");

      if (providedKey !== env.SECRET_KEY) {
        return new Response(JSON.stringify({ error: "密钥错误" }), { status: 403, headers: corsHeaders });
      }

      const result = await env.DB.prepare(
        "SELECT source, subject, content, datetime(created_at, '+8 hours') as local_time FROM messages WHERE address = ? ORDER BY id DESC LIMIT 1"
      ).bind(targetEmail?.toLowerCase().trim()).first();
      
      if (!result) {
        return new Response(JSON.stringify({ error: "未收到邮件" }), { status: 404, headers: corsHeaders });
      }

      // 精准提取验证码：找 class="code-box" 的内容，或被 > < 包裹的数字
      let code = "未找到";
      const traeMatch = result.content.match(/class="code-box"[^>]*>\\s*(\\d+)\\s*<\\/span>/);
      const universalMatch = result.content.match(/>\\s*(\\d{4,8})\\s*<\\//);
      if (traeMatch) code = traeMatch[1];
      else if (universalMatch) code = universalMatch[1];

      // 检查是否是浏览器直接访问（根据 Accept 头）
      const acceptHeader = request.headers.get('Accept') || '';
      const isBrowser = acceptHeader.includes('text/html');

      if (isBrowser) {
        // 浏览器访问，返回简洁的 HTML 页面
        const html = '<!DOCTYPE html>' +
          '<html>' +
          '<head>' +
          '  <meta charset="UTF-8">' +
          '  <title>验证码</title>' +
          '  <style>' +
          '    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }' +
          '    .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }' +
          '    .label { color: #666; font-size: 14px; margin-bottom: 8px; }' +
          '    .email { color: #333; font-size: 16px; margin-bottom: 24px; word-break: break-all; }' +
          '    .code-label { color: #666; font-size: 14px; margin-bottom: 12px; }' +
          '    .code { font-size: 48px; font-weight: bold; color: #667eea; letter-spacing: 8px; margin-bottom: 24px; }' +
          '    .time { color: #999; font-size: 12px; }' +
          '  </style>' +
          '</head>' +
          '<body>' +
          '  <div class="container">' +
          '    <div class="label">邮箱</div>' +
          '    <div class="email">' + targetEmail + '</div>' +
          '    <div class="code-label">验证码</div>' +
          '    <div class="code">' + code + '</div>' +
          '    <div class="time">' + result.local_time + ' (北京时间)</div>' +
          '  </div>' +
          '</body>' +
          '</html>';
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html;charset=UTF-8", ...corsHeaders } });
      } else {
        // API 调用，返回 JSON
        return new Response(JSON.stringify({
          email: targetEmail,
          subject: result.subject,
          code: code,
          time: result.local_time
        }), { status: 200, headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders } });
      }
    }
    return new Response("Service Running", { headers: corsHeaders });
  },

  async email(message, env) {
    await env.DB.prepare(\`DELETE FROM messages WHERE created_at < datetime('now', '-5 minute')\`).run();
    const rawContent = await new Response(message.raw).text();
    const subject = message.headers.get("subject") || "无主题";
    const toAddress = (message.to || "").toLowerCase().trim();

    let finalBody = "";
    if (rawContent.includes("text/html")) {
      const parts = rawContent.split("Content-Type: text/html");
      const htmlPart = parts[1] ? parts[1].split("--")[0] : "";
      if (htmlPart.includes("base64")) {
        const base64Data = htmlPart.split("\\r\\n\\r\\n")[1] || htmlPart.split("\\n\\n")[1];
        if (base64Data) {
          try {
            const decoded = atob(base64Data.replace(/[\\r\\n\\s]/g, ""));
            finalBody = decodeURIComponent(escape(decoded));
          } catch (e) { finalBody = atob(base64Data.replace(/[\\r\\n\\s]/g, "")); }
        }
      } else {
        finalBody = htmlPart.split("\\r\\n\\r\\n")[1] || htmlPart;
        finalBody = finalBody.replace(/=\\r?\\n/g, "").replace(/=([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16)));
      }
    } else {
      finalBody = rawContent.substring(Math.max(0, rawContent.indexOf("\\r\\n\\r\\n")));
    }

    try {
      await env.DB.prepare("INSERT INTO messages (address, source, subject, content) VALUES (?, ?, ?, ?)").bind(toAddress, message.from, subject, finalBody).run();
    } catch (e) { console.error(e.message); }
  }
};`;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(workerCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const styles: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '20px',
    },
    modal: {
      backgroundColor: '#fff',
      borderRadius: '16px',
      width: '100%',
      maxWidth: '900px',
      maxHeight: '85vh',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '24px 28px',
      borderBottom: '1px solid #e5e7eb',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    },
    title: {
      fontSize: '22px',
      fontWeight: 700,
      color: '#fff',
      margin: 0,
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
    },
    closeBtn: {
      background: 'rgba(255,255,255,0.2)',
      border: 'none',
      width: '36px',
      height: '36px',
      borderRadius: '50%',
      cursor: 'pointer',
      fontSize: '24px',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'all 0.2s',
    },
    content: {
      padding: '28px',
      overflowY: 'auto',
      flex: 1,
      backgroundColor: '#f9fafb',
    },
    section: {
      marginBottom: '32px',
      backgroundColor: '#fff',
      borderRadius: '12px',
      padding: '24px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    },
    sectionTitle: {
      fontSize: '18px',
      fontWeight: 700,
      color: '#1f2937',
      marginBottom: '16px',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    },
    sectionDesc: {
      fontSize: '15px',
      color: '#6b7280',
      lineHeight: 1.7,
      marginBottom: '20px',
    },
    phase: {
      marginBottom: '28px',
    },
    phaseTitle: {
      fontSize: '16px',
      fontWeight: 600,
      color: '#374151',
      marginBottom: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    phaseNumber: {
      width: '28px',
      height: '28px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      fontWeight: 700,
    },
    ol: {
      margin: '0 0 0 20px',
      padding: 0,
      color: '#4b5563',
      fontSize: '14px',
      lineHeight: 2,
    },
    li: {
      marginBottom: '8px',
    },
    code: {
      backgroundColor: '#f3f4f6',
      padding: '2px 8px',
      borderRadius: '4px',
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#dc2626',
    },
    codeBlock: {
      backgroundColor: '#1f2937',
      color: '#e5e7eb',
      padding: '16px',
      borderRadius: '8px',
      overflow: 'auto',
      fontSize: '12px',
      lineHeight: 1.5,
      marginTop: '12px',
      maxHeight: '300px',
    },
    expandButton: {
      backgroundColor: '#f3f4f6',
      border: '1px solid #e5e7eb',
      padding: '10px 16px',
      borderRadius: '8px',
      fontSize: '14px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginTop: '12px',
      color: '#374151',
    },
    copyButton: {
      position: 'absolute',
      top: '12px',
      right: '12px',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      color: '#e5e7eb',
      padding: '8px 16px',
      borderRadius: '6px',
      fontSize: '13px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      transition: 'all 0.2s',
      zIndex: 10,
    },
    copyButtonCopied: {
      backgroundColor: 'rgba(34, 197, 94, 0.2)',
      borderColor: 'rgba(34, 197, 94, 0.4)',
      color: '#22c55e',
    },
    note: {
      backgroundColor: '#fef3c7',
      borderLeft: '4px solid #f59e0b',
      padding: '16px 20px',
      borderRadius: '8px',
      marginTop: '20px',
      fontSize: '14px',
      color: '#92400e',
    },
    important: {
      backgroundColor: '#fee2e2',
      borderLeft: '4px solid #dc2626',
      padding: '12px 16px',
      borderRadius: '8px',
      marginTop: '12px',
      fontSize: '14px',
      color: '#991b1b',
    },
    actions: {
      padding: '20px 28px',
      borderTop: '1px solid #e5e7eb',
      backgroundColor: '#fff',
      display: 'flex',
      justifyContent: 'flex-end',
    },
    button: {
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: '#fff',
      border: 'none',
      padding: '12px 32px',
      borderRadius: '8px',
      fontSize: '15px',
      fontWeight: 600,
      cursor: 'pointer',
      transition: 'all 0.2s',
    },
    link: {
      color: '#667eea',
      textDecoration: 'none',
      fontWeight: 500,
    },
    testBox: {
      backgroundColor: '#ecfdf5',
      border: '1px solid #6ee7b7',
      borderRadius: '8px',
      padding: '16px',
      marginTop: '16px',
    },
    testTitle: {
      fontSize: '15px',
      fontWeight: 600,
      color: '#065f46',
      marginBottom: '8px',
    },
    testUrl: {
      fontSize: '13px',
      color: '#047857',
      fontFamily: 'monospace',
      wordBreak: 'break-all',
    },
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            Cloudflare Worker 配置教程
          </h2>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {/* 第一阶段：准备域名 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>🌐</span> 第一阶段：准备域名（Domain）
            </h3>
            <div style={styles.phase}>
              <div style={styles.phaseTitle}>
                <span style={styles.phaseNumber}>1</span>
                添加域名
              </div>
              <p style={styles.sectionDesc}>
                将你的域名（如 <code style={styles.code}>hhxyyq.online</code>）托管到 Cloudflare。
              </p>
            </div>
            <div style={styles.phase}>
              <div style={styles.phaseTitle}>
                <span style={styles.phaseNumber}>2</span>
                激活电子邮件路由
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>进入 Cloudflare 控制台，选择你的域名</li>
                <li style={styles.li}>点击左侧菜单 <strong>"电子邮件 (Email)"</strong> → <strong>"电子邮件路由 (Email Routing)"</strong></li>
                <li style={styles.li}>点击 <strong>"启用电子邮件路由"</strong></li>
                <li style={styles.li}>
                  <strong>关键步骤</strong>：在"DNS 设置"页签，点击 <strong>"自动添加记录"</strong>
                  <div style={styles.important}>
                    确保 MX 记录和 SPF 记录状态都变为"已激活"
                  </div>
                </li>
              </ol>
            </div>
          </div>

          {/* 第二阶段：创建数据库 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>🗄️</span> 第二阶段：创建数据库（D1 Database）
            </h3>
            <ol style={styles.ol}>
              <li style={styles.li}>在 Cloudflare 侧边栏点击 <strong>"存储和数据库"</strong> → <strong>"D1"</strong></li>
              <li style={styles.li}>点击 <strong>"创建数据库"</strong> → <strong>"创建"</strong></li>
              <li style={styles.li}>
                名称：输入 <code style={styles.code}>trae-emails</code>（或者你喜欢的名字）
              </li>
              <li style={styles.li}>
                创建成功后，点击进入该数据库，选择 <strong>"控制台 (Console)"</strong>
              </li>
              <li style={styles.li}>
                初始化表结构：粘贴以下 SQL 代码并点击 <strong>"执行"</strong>：
                <div style={{ marginTop: '12px', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                  {/* SQL 代码头部 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', background: '#f9fafb', borderBottom: showSql ? '1px solid #e5e7eb' : 'none' }}>
                    <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>SQL</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT,
  source TEXT,
  subject TEXT,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`);
                          setSqlCopied(true);
                          setTimeout(() => setSqlCopied(false), 2000);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          background: '#fff',
                          color: sqlCopied ? '#059669' : '#374151',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                      >
                        {sqlCopied ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            已复制
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                            复制
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setShowSql(!showSql)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          background: '#fff',
                          color: '#374151',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: showSql ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                        {showSql ? '收起' : '展开'}
                      </button>
                    </div>
                  </div>
                  {/* SQL 代码内容 */}
                  {showSql && (
                    <pre style={{ ...styles.codeBlock, margin: 0, borderRadius: 0 }}>{`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT,
  source TEXT,
  subject TEXT,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`}</pre>
                  )}
                </div>
              </li>
            </ol>
          </div>

          {/* 第三阶段：部署 Worker 脚本 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>⚡</span> 第三阶段：部署 Worker 脚本
            </h3>
            <ol style={styles.ol}>
              <li style={styles.li}>在侧边栏点击 <strong>"Workers 和 Pages"</strong> → <strong>"创建"</strong> → <strong>"创建 Worker"</strong></li>
              <li style={styles.li}>名称：输入 <code style={styles.code}>trae-temp-mail</code></li>
              <li style={styles.li}>点击 <strong>"部署"</strong>，然后点击 <strong>"编辑代码"</strong></li>
              <li style={styles.li}>
                清空内容，粘贴以下经过优化的完整代码（支持 5 分钟清理、Base64 解码、精准提取）：
                <button 
                  style={styles.expandButton} 
                  onClick={() => setShowCode(!showCode)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {showCode ? (
                      <path d="M18 15l-6-6-6 6"/>
                    ) : (
                      <path d="M6 9l6 6 6-6"/>
                    )}
                  </svg>
                  {showCode ? '收起代码' : '点击展开查看完整代码'}
                </button>
                {showCode && (
                  <div style={{ position: 'relative', marginTop: '12px' }}>
                    <button
                      style={{
                        ...styles.copyButton,
                        ...(copied ? styles.copyButtonCopied : {}),
                      }}
                      onClick={handleCopyCode}
                    >
                      {copied ? (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                          已复制
                        </>
                      ) : (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                          复制代码
                        </>
                      )}
                    </button>
                    <pre style={styles.codeBlock}>{workerCode}</pre>
                  </div>
                )}
              </li>
              <li style={styles.li}>点击右上角 <strong>"部署"</strong></li>
            </ol>
          </div>

          {/* 第四阶段：配置绑定 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>🔗</span> 第四阶段：配置绑定（关键，决定能否运行）
            </h3>
            <p style={styles.sectionDesc}>
              回到 Worker 的管理界面，点击 <strong>"设置 (Settings)"</strong> 选项卡。
            </p>
            
            <div style={styles.phase}>
              <div style={styles.phaseTitle}>
                <span style={styles.phaseNumber}>1</span>
                绑定数据库
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>点击左侧 <strong>"变量 (Variables)"</strong> → 往下滚到 <strong>"D1 数据库绑定"</strong></li>
                <li style={styles.li}>点击 <strong>"添加绑定"</strong></li>
                <li style={styles.li}>变量名称：填写 <code style={styles.code}>DB</code>（必须大写）</li>
                <li style={styles.li}>D1 数据库：选择你刚才创建的 <code style={styles.code}>trae-emails</code></li>
                <li style={styles.li}>点击 <strong>"保存"</strong></li>
              </ol>
            </div>

            <div style={styles.phase}>
              <div style={styles.phaseTitle}>
                <span style={styles.phaseNumber}>2</span>
                设置密钥
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>在同一个"变量"页面，点击顶部 <strong>"环境变量"</strong> 处的 <strong>"添加变量"</strong></li>
                <li style={styles.li}>名称：<code style={styles.code}>SECRET_KEY</code></li>
                <li style={styles.li}>值：设置你的密钥（如 <code style={styles.code}>qweasd123</code>）</li>
                <li style={styles.li}>点击 <strong>"保存并部署"</strong></li>
              </ol>
            </div>

            <div style={styles.phase}>
              <div style={styles.phaseTitle}>
                <span style={styles.phaseNumber}>3</span>
                添加自定义域名
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>点击左侧 <strong>"域和路由 (Domains & Routes)"</strong></li>
                <li style={styles.li}>点击 <strong>"添加"</strong> → <strong>"自定义域"</strong></li>
                <li style={styles.li}>输入 <code style={styles.code}>hhxyyq.online</code> 并确认</li>
              </ol>
            </div>
          </div>

          {/* 第五阶段：打通邮件通道 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>📧</span> 第五阶段：打通邮件通道（最后一步）
            </h3>
            <ol style={styles.ol}>
              <li style={styles.li}>回到域名控制台（<code style={styles.code}>hhxyyq.online</code>）</li>
              <li style={styles.li}>点击 <strong>"电子邮件"</strong> → <strong>"电子邮件路由"</strong> → <strong>"路由规则"</strong></li>
              <li style={styles.li}>找到 <strong>"Catch-all"</strong> (捕获所有)，点击 <strong>"编辑"</strong></li>
              <li style={styles.li}>操作：选择 <strong>"发送到 Worker"</strong></li>
              <li style={styles.li}>目标 Worker：选择 <code style={styles.code}>trae-temp-mail</code></li>
              <li style={styles.li}>点击保存</li>
            </ol>
          </div>

          {/* 如何测试 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>🧪</span> 如何测试？
            </h3>
            <ol style={styles.ol}>
              <li style={styles.li}>
                <strong>发送邮件</strong>：用你的 QQ 邮箱给 <code style={styles.code}>test@hhxyyq.online</code> 发送一封信
              </li>
              <li style={styles.li}>
                <strong>调用接口</strong>：在浏览器访问：
                <div style={styles.testBox}>
                  <div style={styles.testTitle}>测试 URL</div>
                  <div style={styles.testUrl}>
                    https://hhxyyq.online/api/get-code?key=你的密钥&email=test@hhxyyq.online
                  </div>
                </div>
              </li>
              <li style={styles.li}>
                <strong>查看结果</strong>：你应该能看到 JSON 返回，其中 <code style={styles.code}>code</code> 是验证码，<code style={styles.code}>full_html</code> 是网页
              </li>
            </ol>
          </div>

          {/* 注意事项 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>⚠️</span> 注意事项
            </h3>
            <ul style={{ margin: '0 0 0 20px', padding: 0, color: '#4b5563', fontSize: '14px', lineHeight: 2 }}>
              <li style={styles.li}><strong>安全性</strong>：请妥善保管 <code style={styles.code}>SECRET_KEY</code>，不要泄露给他人</li>
              <li style={styles.li}><strong>数据保留</strong>：临时邮箱数据会在 5 分钟后自动删除</li>
              <li style={styles.li}><strong>验证码提取</strong>：支持 Trae 的 <code style={styles.code}>code-box</code> 元素和通用数字匹配</li>
            </ul>
          </div>
        </div>

        {/* Actions */}
        <div style={styles.actions}>
          <button style={styles.button} onClick={onClose}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}
