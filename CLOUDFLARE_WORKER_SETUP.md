# Cloudflare Worker 配置教程

## 功能说明

Cloudflare Worker 用于提供临时邮箱服务，支持快速注册 Trae 账号。

## 部署步骤

### 1. 创建 Cloudflare Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 点击左侧菜单 **Workers & Pages**
3. 点击 **创建服务**
4. 输入服务名称（如 `trae-temp-mail`）
5. 点击 **创建服务**

### 2. 创建 D1 数据库

D1 是 Cloudflare 提供的 SQLite 数据库，用于存储接收到的邮件内容和验证码。

1. 在 Workers & Pages 页面，点击 **D1**
2. 点击 **创建数据库**
3. 输入名称：`trae-emails`
4. 点击 **创建**

### 3. 绑定 D1 数据库到 Worker

1. 进入刚创建的 Worker 详情页
2. 点击 **设置** 标签
3. 点击 **变量** 选项卡
4. 在 **D1 数据库绑定** 部分，点击 **添加绑定**
5. 变量名称填写：`DB`
6. 数据库选择刚才创建的 `trae-emails`
7. 点击 **保存**

### 4. 设置环境变量

在 Worker 的 **变量** 页面，添加以下环境变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `SECRET_KEY` | 你的密钥 | API 认证密钥，建议使用随机字符串 |
| `EMAIL_DOMAIN` | 你的域名 | 临时邮箱域名，如 `temp.example.com` |

### 5. 部署 Worker 代码

将下面的代码复制到 Worker 的编辑器中，点击 **保存并部署**：

```javascript
// Cloudflare Worker 代码 - 临时邮箱服务
export default {
  async fetch(request, env, ctx) {
    // 获取请求路径
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 设置 CORS 头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // 验证密钥
    const authHeader = request.headers.get('Authorization');
    const expectedAuth = `Bearer ${env.SECRET_KEY}`;
    
    if (authHeader !== expectedAuth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    try {
      // 路由处理
      if (path === '/create' && request.method === 'POST') {
        return await handleCreate(request, env, corsHeaders);
      }
      
      if (path === '/check' && request.method === 'POST') {
        return await handleCheck(request, env, corsHeaders);
      }
      
      if (path === '/stats' && request.method === 'GET') {
        return await handleStats(env, corsHeaders);
      }
      
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

// 创建临时邮箱
async function handleCreate(request, env, corsHeaders) {
  const { prefix } = await request.json().catch(() => ({}));
  
  // 生成随机邮箱地址
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  const emailPrefix = prefix || `temp_${random}`;
  const email = `${emailPrefix}@${env.EMAIL_DOMAIN}`;
  
  // 生成 token
  const token = `${timestamp}_${random}_${generateRandomString(16)}`;
  
  // 存储到 KV
  const data = {
    email,
    token,
    code: null,
    created_at: timestamp,
    expires_at: timestamp + 24 * 60 * 60 * 1000, // 24小时过期
  };
  
  await env.TRA_EMAILS.put(email, JSON.stringify(data), {
    expirationTtl: 24 * 60 * 60, // 24小时过期
  });
  
  return new Response(JSON.stringify({
    success: true,
    email,
    token,
    expires_at: data.expires_at,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// 检查验证码
async function handleCheck(request, env, corsHeaders) {
  const { email, token } = await request.json().catch(() => ({}));
  
  if (!email || !token) {
    return new Response(JSON.stringify({ error: 'Missing email or token' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // 从 KV 获取数据
  const data = await env.TRA_EMAILS.get(email);
  
  if (!data) {
    return new Response(JSON.stringify({ error: 'Email not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  const emailData = JSON.parse(data);
  
  // 验证 token
  if (emailData.token !== token) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  // 检查是否过期
  if (Date.now() > emailData.expires_at) {
    return new Response(JSON.stringify({ error: 'Email expired' }), {
      status: 410,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify({
    success: true,
    email,
    code: emailData.code,
    has_code: !!emailData.code,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// 获取统计信息
async function handleStats(env, corsHeaders) {
  // 列出所有键（最多1000个）
  const list = await env.TRA_EMAILS.list();
  const total = list.keys.length;
  
  // 统计未使用的邮箱
  let available = 0;
  for (const key of list.keys) {
    const data = await env.TRA_EMAILS.get(key.name);
    if (data) {
      const emailData = JSON.parse(data);
      if (!emailData.code && Date.now() < emailData.expires_at) {
        available++;
      }
    }
  }
  
  return new Response(JSON.stringify({
    success: true,
    data: {
      total_count: total,
      available_count: available,
    },
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// 生成随机字符串
function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
```

### 6. 配置域名（可选）

如果你想使用自定义域名而不是 `.workers.dev`：

1. 在 Worker 详情页，点击 **触发器** 标签
2. 点击 **添加自定义域**
3. 输入你的域名（如 `api.example.com`）
4. 按照提示添加 DNS 记录
5. 等待 DNS 生效

### 7. 在应用中配置

1. 打开 Trae 账号管理应用
2. 点击 **添加账号** → **快速注册**
3. 在 Cloudflare Worker 配置区域填写：
   - **Worker URL**: `https://your-worker.your-subdomain.workers.dev`
   - **Secret Key**: 你在环境变量中设置的密钥
   - **邮箱域名**: 你在环境变量中设置的域名
4. 点击 **保存配置**

### 8. 测试

点击 **获取二维码**，如果配置正确，系统会：
1. 通过 Worker 创建临时邮箱
2. 显示二维码供微信扫描
3. 自动获取验证码
4. 完成 Trae 账号注册

## API 接口说明

### 创建临时邮箱

```http
POST /create
Authorization: Bearer {SECRET_KEY}
Content-Type: application/json

{
  "prefix": "optional_prefix"  // 可选，自定义邮箱前缀
}

响应：
{
  "success": true,
  "email": "temp_xxx@example.com",
  "token": "timestamp_random_xxx",
  "expires_at": 1234567890
}
```

### 检查验证码

```http
POST /check
Authorization: Bearer {SECRET_KEY}
Content-Type: application/json

{
  "email": "temp_xxx@example.com",
  "token": "timestamp_random_xxx"
}

响应：
{
  "success": true,
  "email": "temp_xxx@example.com",
  "code": "123456",  // 验证码，如果没有则为 null
  "has_code": true
}
```

### 获取统计

```http
GET /stats
Authorization: Bearer {SECRET_KEY}

响应：
{
  "success": true,
  "data": {
    "total_count": 100,
    "available_count": 50
  }
}
```

## 注意事项

1. **安全性**: 请妥善保管 `SECRET_KEY`，不要泄露给他人
2. **配额**: Cloudflare Worker 有每日请求限制，免费版为 100,000 次/天
3. **数据保留**: 临时邮箱数据会在 24 小时后自动删除
4. **验证码接收**: 需要配合邮件接收服务，将收到的验证码写入 KV

## 邮件接收配置（进阶）

如果你需要接收真实邮件并提取验证码，可以使用以下方式：

### 方案 1: 使用 Cloudflare Email Routing

1. 在 Cloudflare 域名设置中启用 Email Routing
2. 将所有邮件转发到 Webhook
3. Webhook 解析邮件内容并提取验证码
4. 将验证码写入 KV

### 方案 2: 使用第三方邮件服务

使用如 Mailgun、SendGrid 等服务接收邮件，通过 Webhook 处理。

---

如有问题，请检查 Worker 日志或联系开发者。
