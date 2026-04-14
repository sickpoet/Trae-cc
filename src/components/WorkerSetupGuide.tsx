import { useState } from 'react';

interface WorkerSetupGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

export function WorkerSetupGuide({ isOpen, onClose }: WorkerSetupGuideProps) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const workerCode = `// Cloudflare Worker 代码 - 临时邮箱服务
// 使用 D1 数据库存储邮件，支持自动接收邮件和提取验证码

export default {
  async fetch(request, env) {
    // 1. 设置跨域头（CORS），允许前端跨域调用这个接口
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 处理浏览器的 OPTIONS 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 初始化/升级数据库
    await env.DB.prepare(\`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, source TEXT, subject TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)\`).run();
    try { await env.DB.prepare(\`ALTER TABLE messages ADD COLUMN content TEXT\`).run(); } catch(e) {}

    // 每次有请求时，自动清理超过1分钟的验证码/邮箱数据
    await env.DB.prepare(\`DELETE FROM messages WHERE created_at < datetime('now', '-1 minute')\`).run();

    // 提供专属 API 接口供前端调用
    if (url.pathname === "/api/get-code") {
      
      // 2. 验证前端传来的密钥 (参数名为 key)
      const providedKey = url.searchParams.get("key");
      if (providedKey !== env.SECRET_KEY) {
        return new Response(JSON.stringify({ error: "密钥错误或未提供" }), {
          status: 403,
          headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
        });
      }

      // 获取前端指定的邮箱地址
      const targetEmail = url.searchParams.get("email");
      if (!targetEmail) {
        return new Response(JSON.stringify({ error: "缺少 email 参数，请提供需要查询的邮箱（例如: &email=test@xxx.com）" }), {
          status: 400,
          headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
        });
      }

      // 3. 读取数据库，针对指定邮箱查询，并转换为北京时间
      // 使用小写比对，防止大小写导致查不到
      const result = await env.DB.prepare("SELECT content, datetime(created_at, '+8 hours') as local_time FROM messages WHERE address = ? ORDER BY id DESC LIMIT 1")
        .bind(targetEmail.toLowerCase().trim())
        .first();
      
      if (!result) {
        return new Response(JSON.stringify({ error: "该邮箱目前没收到邮件，或者验证码已过期被删除（超过1分钟）" }), {
          status: 404,
          headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
        });
      }
      
      const content = result.content || "";
      const localTime = result.local_time;
      
      // 使用正则匹配提取 6 位验证码
      const match = content.match(/\\b\\d{6}\\b/);
      const code = match ? match[0] : "未找到验证码";
      
      // 4. 以 JSON 格式返回验证码和时间
      return new Response(JSON.stringify({
        email: targetEmail,
        code: code,
        time: \`\${localTime} (北京时间)\`
      }), {
        status: 200,
        headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
      });
    }

    return new Response("系统就绪，接口地址为 /api/get-code?key=你的密钥&email=目标邮箱", { headers: corsHeaders });
  },

  async email(message, env) {
    // 收到新邮件时，先清理一遍超过1分钟的历史过期数据
    await env.DB.prepare(\`DELETE FROM messages WHERE created_at < datetime('now', '-1 minute')\`).run();

    const raw = await new Response(message.raw).text();
    // 改进的提取逻辑：找到第一个空行后的内容
    const parts = raw.split(/\\r?\\n\\r?\\n/);
    let body = parts.length > 1 ? parts.slice(1).join('\\n\\n') : raw;
    
    // 简单的解码和清洗
    body = body.replace(/<[^>]+>/g, '') // 删掉 HTML 标签
               .replace(/&nbsp;/g, ' ')
               .replace(/=\\r?\\n/g, '')  // 处理 Quoted-Printable 换行
               .trim();

    // 格式化目标邮箱名称（统一转为小写）
    const toAddress = (message.to || "").toLowerCase().trim();

    try {
      // 存入当前这封新邮件（每个邮箱的数据都单独存放）
      await env.DB.prepare(
        "INSERT INTO messages (address, source, subject, content) VALUES (?, ?, ?, ?)"
      ).bind(toAddress, message.from, message.headers.get("subject") || "无主题", body).run();
    } catch (e) {
      console.error("存入失败:", e.message);
    }
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
    step: {
      marginBottom: '28px',
    },
    stepTitle: {
      fontSize: '16px',
      fontWeight: 600,
      color: '#374151',
      marginBottom: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    stepNumber: {
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
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      marginTop: '16px',
      fontSize: '14px',
    },
    th: {
      backgroundColor: '#f3f4f6',
      padding: '12px 16px',
      textAlign: 'left',
      fontWeight: 600,
      color: '#374151',
      borderBottom: '2px solid #e5e7eb',
    },
    td: {
      padding: '12px 16px',
      borderBottom: '1px solid #e5e7eb',
      color: '#4b5563',
    },
    codeBlockWrapper: {
      position: 'relative',
      marginTop: '16px',
      borderRadius: '10px',
      overflow: 'hidden',
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
    pre: {
      backgroundColor: '#1f2937',
      color: '#e5e7eb',
      padding: '20px',
      borderRadius: '10px',
      overflow: 'auto',
      fontSize: '13px',
      lineHeight: 1.6,
      margin: 0,
    },
    ul: {
      margin: '0 0 0 20px',
      padding: 0,
      color: '#4b5563',
      fontSize: '14px',
      lineHeight: 2,
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
    fileList: {
      display: 'flex',
      gap: '12px',
      flexWrap: 'wrap',
      marginTop: '12px',
    },
    fileItem: {
      backgroundColor: '#f3f4f6',
      padding: '8px 16px',
      borderRadius: '6px',
      fontSize: '13px',
      color: '#374151',
      fontFamily: 'monospace',
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
          {/* 功能说明 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>📋</span> 功能说明
            </h3>
            <p style={styles.sectionDesc}>
              Cloudflare Worker 用于提供临时邮箱服务，支持快速注册 Trae 账号。
              通过 Worker 可以自动创建临时邮箱、接收验证码，实现一键注册。
            </p>
          </div>

          {/* 部署步骤 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>🚀</span> 部署步骤
            </h3>

            {/* Step 1 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>1</span>
                创建 Cloudflare Worker
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>登录 <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer" style={styles.link}>Cloudflare Dashboard</a></li>
                <li style={styles.li}>点击左侧菜单 <strong>Workers & Pages</strong></li>
                <li style={styles.li}>点击 <strong>创建服务</strong></li>
                <li style={styles.li}>输入服务名称（如 <code style={styles.code}>trae-temp-mail</code>）</li>
                <li style={styles.li}>点击 <strong>创建服务</strong></li>
              </ol>
            </div>

            {/* Step 2 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>2</span>
                创建 D1 数据库
              </div>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '12px' }}>
                D1 是 Cloudflare 提供的 SQLite 数据库，用于存储接收到的邮件内容和验证码。
              </p>
              <ol style={styles.ol}>
                <li style={styles.li}>在 Workers & Pages 页面，点击 <strong>D1</strong></li>
                <li style={styles.li}>点击 <strong>创建数据库</strong></li>
                <li style={styles.li}>输入名称：<code style={styles.code}>trae-emails</code></li>
                <li style={styles.li}>点击 <strong>创建</strong></li>
              </ol>
            </div>

            {/* Step 3 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>3</span>
                绑定 D1 数据库到 Worker
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>进入刚创建的 Worker 详情页</li>
                <li style={styles.li}>点击 <strong>设置</strong> 标签</li>
                <li style={styles.li}>点击 <strong>变量</strong> 选项卡</li>
                <li style={styles.li}>在 <strong>D1 数据库绑定</strong> 部分，点击 <strong>添加绑定</strong></li>
                <li style={styles.li}>变量名称填写：<code style={styles.code}>DB</code></li>
                <li style={styles.li}>数据库选择刚才创建的 <code style={styles.code}>trae-emails</code></li>
                <li style={styles.li}>点击 <strong>保存</strong></li>
              </ol>
            </div>

            {/* Step 4 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>4</span>
                设置环境变量
              </div>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '12px' }}>
                在 Worker 的 <strong>变量</strong> 页面，添加以下环境变量：
              </p>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>变量名</th>
                    <th style={styles.th}>值</th>
                    <th style={styles.th}>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={styles.td}><code style={styles.code}>SECRET_KEY</code></td>
                    <td style={styles.td}>你的密钥</td>
                    <td style={styles.td}>API 认证密钥，建议使用随机字符串</td>
                  </tr>
                  <tr>
                    <td style={styles.td}><code style={styles.code}>EMAIL_DOMAIN</code></td>
                    <td style={styles.td}>你的域名</td>
                    <td style={styles.td}>临时邮箱域名，如 temp.example.com</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Step 5 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>5</span>
                部署 Worker 代码
              </div>
              <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '12px' }}>
                将下面的代码复制到 Worker 的编辑器中，点击 <strong>保存并部署</strong>：
              </p>
              <div style={styles.codeBlockWrapper}>
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
                <pre style={styles.pre}>{workerCode}</pre>
              </div>
            </div>

            {/* Step 6 */}
            <div style={styles.step}>
              <div style={styles.stepTitle}>
                <span style={styles.stepNumber}>6</span>
                在应用中配置
              </div>
              <ol style={styles.ol}>
                <li style={styles.li}>打开 Trae 账号管理应用</li>
                <li style={styles.li}>点击 <strong>添加账号</strong> → <strong>快速注册</strong></li>
                <li style={styles.li}>在 Cloudflare Worker 配置区域填写：
                  <ul style={{ marginTop: '8px', color: '#6b7280' }}>
                    <li><strong>Worker URL</strong>: <code style={styles.code}>https://your-worker.your-subdomain.workers.dev</code></li>
                    <li><strong>Secret Key</strong>: 你在环境变量中设置的密钥</li>
                    <li><strong>邮箱域名</strong>: 你在环境变量中设置的域名</li>
                  </ul>
                </li>
                <li style={styles.li}>点击 <strong>保存配置</strong></li>
              </ol>
            </div>
          </div>

          {/* 注意事项 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>⚠️</span> 注意事项
            </h3>
            <ul style={styles.ul}>
              <li style={styles.li}><strong>安全性</strong>: 请妥善保管 <code style={styles.code}>SECRET_KEY</code>，不要泄露给他人</li>
              <li style={styles.li}><strong>配额</strong>: Cloudflare Worker 有每日请求限制，免费版为 100,000 次/天</li>
              <li style={styles.li}><strong>数据保留</strong>: 临时邮箱数据会在 24 小时后自动删除</li>
              <li style={styles.li}><strong>验证码接收</strong>: 需要配合邮件接收服务，将收到的验证码写入 KV</li>
            </ul>
          </div>

          {/* 相关文件 */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <span>📁</span> 相关文件
            </h3>
            <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '12px' }}>
              项目目录下已生成以下文件供参考：
            </p>
            <div style={styles.fileList}>
              <span style={styles.fileItem}>CLOUDFLARE_WORKER_SETUP.md</span>
              <span style={styles.fileItem}>worker.js</span>
            </div>
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
