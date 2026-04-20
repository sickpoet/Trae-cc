/**
 * 测试 GitHub Pages 更新检查功能
 * 运行方式: npx tsx test-update.ts
 */

const UPDATE_URL = "https://hhh9201.github.io/Trae-cc/release/latest.json";

async function testUpdateCheck() {
  console.log("=== GitHub Pages 更新检查测试 ===\n");
  
  console.log(`📡 测试 URL: ${UPDATE_URL}\n`);
  
  try {
    // 1. 测试基本访问
    console.log("1️⃣  测试 HTTP GET 请求...");
    const response = await fetch(UPDATE_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });
    
    console.log(`   ✅ 状态码: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      console.log(`   ❌ 错误: HTTP ${response.status}`);
      return;
    }
    
    // 2. 解析响应
    console.log("\n2️⃣  解析响应内容...");
    const data = await response.json();
    console.log("   ✅ JSON 解析成功:");
    console.log("   ", JSON.stringify(data, null, 4));
    
    // 3. 版本比较
    console.log("\n3️⃣  版本比较测试:");
    const currentVersion = "1.0.5"; // 你的测试版本
    const remoteVersion = data.version;
    
    console.log(`   当前版本: ${currentVersion}`);
    console.log(`   远程版本: ${remoteVersion}`);
    
    const isNewer = compareVersions(remoteVersion, currentVersion);
    console.log(`   需要更新: ${isNewer ? "✅ 是" : "❌ 否（已是最新）"}`);
    
    if (isNewer) {
      console.log("\n📦 更新信息:");
      console.log(`   版本: ${data.version}`);
      console.log(`   说明: ${data.notes}`);
      console.log(`   日期: ${data.pub_date}`);
      console.log(`   下载: ${data.download_url}`);
    }
    
    console.log("\n✅ 所有测试通过！GitHub Pages 访问正常。");
    
  } catch (error: any) {
    console.error("\n❌ 测试失败!");
    console.error("   错误类型:", error.name);
    console.error("   错误消息:", error.message);
    
    if (error.cause) {
      console.error("   原因:", error.cause);
    }
    
    console.log("\n🔧 可能的原因:");
    console.log("   1. 网络连接问题");
    console.log("   2. DNS 解析失败");
    console.log("   3. 防火墙/代理拦截");
    console.log("   4. GitHub Pages 尚未部署完成");
  }
}

function compareVersions(newVer: string, currentVer: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const newParts = parse(newVer);
  const curParts = parse(currentVer);
  
  for (let i = 0; i < Math.max(newParts.length, curParts.length); i++) {
    const newPart = newParts[i] || 0;
    const curPart = curParts[i] || 0;
    
    if (newPart > curPart) return true;
    if (newPart < curPart) return false;
  }
  
  return false;
}

testUpdateCheck();
