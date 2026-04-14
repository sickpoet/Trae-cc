// Cloudflare Worker 代码 - 临时邮箱服务
// 用于 Trae 账号管理应用的快速注册功能

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
