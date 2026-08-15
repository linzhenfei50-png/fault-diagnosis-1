/**
 * CloudBase HTTP 云函数（Web 函数）— fault-diagnosis-api
 *
 * 数据层从 Cloudflare Workers + D1(SQLite) 迁移到腾讯云云开发(云函数 + NoSQL)。
 * 通过 scf_bootstrap 启动，监听 0.0.0.0:9000。
 *
 * 集合（对应原 3 张表）：
 *   fault_entries      — 导入的故障知识条目（业务 id 作为 _id）
 *   diagnosis_history  — 诊断历史
 *   imported_files     — 文件导入追踪
 */

'use strict';

const http = require('http');
const https = require('https');
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({
  env: process.env.TCB_ENV_ID || 'fault-diagnosis-d5fe6kc909f3385d',
});
const db = app.database();
const _ = db.command;

const PORT = 9000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return { statusCode: status, data };
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** 去掉路径里可能被 HTTP 访问服务加上的前缀，统一成叶子路径 */
function normalizePath(url) {
  const path = url.split('?')[0] || '/';
  for (const prefix of ['/fault-diagnosis-api', '/api']) {
    if (path === prefix) return '/';
    if (path.startsWith(prefix + '/')) return path.slice(prefix.length);
  }
  return path;
}

function parseQuery(url) {
  const query = {};
  const qs = url.split('?')[1] || '';
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  }
  return query;
}

function parseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

/** NoSQL 文档 _id → 前端 id 字段 */
function mapFaultDoc(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function mapHistoryDoc(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function mapFileDoc(doc) {
  return { id: doc._id, fileName: doc.fileName, importedAt: doc.importedAt };
}

async function clearCollection(name) {
  await db.collection(name).where({ _id: _.exists(true) }).remove();
}

// ---------------------------------------------------------------------------
// Fault entries
// ---------------------------------------------------------------------------

async function listFaults() {
  const res = await db.collection('fault_entries').limit(1000).get();
  return json((res.data || []).map(mapFaultDoc));
}

async function saveFaults(entries) {
  if (!Array.isArray(entries)) return error('Expected an array of fault entries');

  for (const entry of entries) {
    const doc = {
      deviceType: entry.deviceType || '通用',
      title: entry.title,
      symptoms: entry.symptoms || [],
      keywords: entry.keywords || [],
      summary: entry.summary || '',
      severity: entry.severity || '中',
      shutdownRequired: Boolean(entry.shutdownRequired),
      estimatedTime: entry.estimatedTime || '',
      causes: entry.causes || [],
      solutions: entry.solutions || [],
      diagram: entry.diagram || [],
      safety: entry.safety || '',
      _images: entry._images || [],
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    await db.collection('fault_entries').doc(String(entry.id)).set(doc);
  }
  return json({ saved: entries.length });
}

async function deleteFault(id) {
  await db.collection('fault_entries').doc(decodeURIComponent(id)).remove();
  return json({ success: true });
}

async function clearFaults() {
  await clearCollection('fault_entries');
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function listHistory(query) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 20));
  const offset = Math.max(0, parseInt(query.offset) || 0);

  const res = await db.collection('diagnosis_history')
    .orderBy('createdAt', 'desc')
    .skip(offset)
    .limit(limit)
    .get();

  return json((res.data || []).map(mapHistoryDoc));
}

async function searchHistory(query) {
  const q = (query.q || '').toLowerCase().replace(/\s+/g, '');
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));

  if (!q) return listHistory(query);

  const res = await db.collection('diagnosis_history')
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();

  const filtered = (res.data || [])
    .filter((r) => {
      const haystack = [r.input, r.title, r.deviceType, (r.matchedKeywords || []).join(' ')]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, limit);

  return json(filtered.map(mapHistoryDoc));
}

async function countHistory() {
  const res = await db.collection('diagnosis_history').count();
  return json({ count: res.total || 0 });
}

async function exportHistory() {
  const res = await db.collection('diagnosis_history')
    .orderBy('createdAt', 'desc')
    .limit(1000)
    .get();
  return json((res.data || []).map(mapHistoryDoc));
}

async function saveHistory(record) {
  if (!record || typeof record !== 'object') return error('Expected a history record object');

  const res = await db.collection('diagnosis_history').add({
    input: record.input || '',
    deviceType: record.deviceType || '',
    faultId: record.faultId || '',
    title: record.title || '',
    severity: record.severity || '',
    matchedKeywords: record.matchedKeywords || [],
    score: record.score || 0,
    causes: record.causes || [],
    solutions: record.solutions || [],
    createdAt: new Date().toISOString(),
  });

  return json({ id: res.id || null });
}

async function deleteHistory(id) {
  await db.collection('diagnosis_history').doc(id).remove();
  return json({ success: true });
}

async function clearHistory() {
  await clearCollection('diagnosis_history');
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function listFiles() {
  const res = await db.collection('imported_files')
    .orderBy('importedAt', 'desc')
    .limit(1000)
    .get();
  return json((res.data || []).map(mapFileDoc));
}

async function markFile(body) {
  if (!body || !body.fileName) return error('Expected { fileName }');

  await db.collection('imported_files').add({
    fileName: body.fileName,
    importedAt: new Date().toISOString(),
  });

  return json({ success: true });
}

async function clearFiles() {
  await clearCollection('imported_files');
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Diagnosis & health
// ---------------------------------------------------------------------------

function serviceInfo() {
  return json({
    service: 'GPU 故障诊断 API',
    endpoints: {
      '/': 'GET 服务说明',
      '/health': 'GET 健康检查',
      '/diagnose': 'POST 发送诊断数据',
      '/api/faults': 'GET/POST/DELETE 故障知识库',
      '/api/history': 'GET/POST/DELETE 诊断历史',
      '/api/history/search': 'GET 搜索历史',
      '/api/history/count': 'GET 历史总数',
      '/api/history/export': 'GET 导出历史',
      '/api/files': 'GET/POST/DELETE 文件追踪',
    },
  });
}

function healthCheck() {
  return json({ status: 'ok', timestamp: new Date().toISOString() });
}

function diagnose(body) {
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体格式错误，请发送有效的 JSON' }, 400);
  }

  const { error_message, logs, gpu_info } = body;

  const diagnosis = {
    received: {
      error_message: error_message || null,
      logs: logs || null,
      gpu_info: gpu_info || null,
    },
    analysis: [],
    suggestions: [],
    timestamp: new Date().toISOString(),
  };

  if (error_message) {
    const msg = error_message.toLowerCase();
    if (msg.includes('out of memory') || msg.includes('oom')) {
      diagnosis.analysis.push('检测到显存不足 (OOM) 错误');
      diagnosis.suggestions.push('尝试减小 batch size 或模型尺寸');
      diagnosis.suggestions.push('检查是否有其他进程占用显存');
    }
    if (msg.includes('cuda') || msg.includes('cudnn')) {
      diagnosis.analysis.push('检测到 CUDA 相关错误');
      diagnosis.suggestions.push('确认 CUDA 版本与驱动匹配');
      diagnosis.suggestions.push('尝试重新安装 CUDA 工具包');
    }
    if (msg.includes('timeout') || msg.includes('time out')) {
      diagnosis.analysis.push('检测到超时错误');
      diagnosis.suggestions.push('检查网络连接或增加超时时间');
    }
    if (msg.includes('permission') || msg.includes('access')) {
      diagnosis.analysis.push('检测到权限错误');
      diagnosis.suggestions.push('检查文件或目录权限设置');
    }
    if (msg.includes('not found') || msg.includes('no such')) {
      diagnosis.analysis.push('检测到文件或路径不存在');
      diagnosis.suggestions.push('检查文件路径是否正确');
    }
  }

  if (diagnosis.analysis.length === 0) {
    diagnosis.analysis.push('未识别到明确的错误模式，建议查看完整日志');
    diagnosis.suggestions.push('检查 GPU 驱动是否正常安装');
    diagnosis.suggestions.push('尝试重启服务或系统');
  }

  return json(diagnosis);
}

// ---------------------------------------------------------------------------
// AI (DeepSeek) proxy — Key 存在环境变量 DEEPSEEK_API_KEY，不经过浏览器
// ---------------------------------------------------------------------------

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

function deepSeekKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

function maskedKey() {
  const k = deepSeekKey();
  return k ? '••••' + k.slice(-4) : '';
}

function httpsPostJson(urlString, headers, bodyJson) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(bodyJson);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode || 0, data: parsed, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('DeepSeek 请求超时')));
    req.write(data);
    req.end();
  });
}

async function callDeepSeek(messages, opts = {}) {
  const apiKey = deepSeekKey();
  if (!apiKey) {
    const e = new Error('服务端未配置 DeepSeek API Key');
    e.status = 503;
    throw e;
  }

  const resp = await httpsPostJson(DEEPSEEK_API, { Authorization: 'Bearer ' + apiKey }, {
    model: DEEPSEEK_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2048,
    top_p: opts.top_p ?? 0.9,
  });

  if (resp.status !== 200) {
    const e = new Error('AI 服务请求失败');
    e.status = resp.status || 502;
    if (resp.status === 401) { e.message = 'API Key 无效'; }
    else if (resp.status === 402) { e.message = 'API 余额不足，请充值'; }
    else if (resp.status === 429) { e.message = '请求过于频繁，请稍后再试'; }
    else { e.message = resp.data?.error?.message || ('HTTP ' + resp.status); }
    throw e;
  }

  const content = resp.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空，请重试');
  return content;
}

function extractJson(text) {
  let content = String(text || '').trim();
  const m = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) content = m[1];
  content = content.trim();
  return JSON.parse(content);
}

const DIAGNOSE_SYSTEM_PROMPT = `你是一名资深的工业设备故障诊断专家，拥有20年现场运维经验。

请根据故障现象和参考知识库，采用"排除法"进行诊断推理，返回严格的 JSON：

{
  "title": "诊断标题",
  "summary": "诊断摘要（80-150字）",
  "severity": "高/中/低",
  "shutdownRequired": true或false,
  "estimatedTime": "预计处理时间",
  "databaseMatch": true或false（此故障类型在参考知识库中是否有匹配条目）,
  "databaseNote": "如果匹配：说明匹配到了什么；如果未匹配：说明这是新故障类型。20-40字",

  "causes": [
    { "name": "原因名称", "probability": 40, "evidence": "判断依据一句话" }
  ],

  "eliminations": [
    { "cause": "被排除的原因", "ruledOut": true, "reason": "排除依据", "evidence": "相关证据" },
    { "cause": "被确认的原因", "ruledOut": false, "reason": "确认依据", "evidence": "相关证据" }
  ],

  "rootCauses": [
    { "scenario": "具体故障场景描述", "detail": "详细的故障机理说明，讲清楚为什么会发生", "probability": 60 }
  ],

  "guidance": {
    "steps": ["排查步骤1", "排查步骤2", "排查步骤3"],
    "tools": ["所需工具"],
    "prevention": "预防再发生的建议"
  },

  "safety": "安全提示"
}

规则：
- causes 列出3-5个可能原因，probability 总和100
- eliminations 至少包含2个被排除项和1个确认项，体现排除推理过程
- rootCauses 给出1-3个最可能的根因，具体描述故障场景
- guidance.steps 给出3-5个可操作的排查/整改步骤
- 必须返回严格合法的 JSON，不要有注释或额外说明`;

const PARSE_SYSTEM_PROMPT = `你是一个工业设备故障数据录入助手。从用户输入的故障描述文本中提取关键信息，返回严格 JSON：

{
  "id": "唯一英文ID，如 rs485-resistor-burn",
  "deviceType": "设备类型，如 通讯电路板",
  "title": "故障标题，20字以内",
  "symptoms": ["故障现象1", "故障现象2"],
  "keywords": ["关键词1", "关键词2"],
  "summary": "诊断摘要，80-150字",
  "severity": "高/中/低",
  "shutdownRequired": true或false,
  "causes": [{"name": "原因", "probability": 40, "evidence": "依据"}],
  "solutions": [{"action": "措施", "detail": "说明", "tools": ["工具"], "duration": "耗时"}],
  "diagram": [{"title": "步骤", "description": "说明"}],
  "safety": "安全提示"
}

只返回JSON，不要markdown标记。`;

function aiStatus() {
  return json({ configured: !!deepSeekKey(), keyMasked: maskedKey() });
}

async function aiDiagnose(body) {
  if (!body || typeof body !== 'object' || !body.symptom) {
    return error('缺少 symptom 字段', 400);
  }

  const symptom = String(body.symptom).slice(0, 300);
  const deviceType = body.deviceType ? String(body.deviceType) : '';
  const knowledgeContext = Array.isArray(body.knowledgeContext) ? body.knowledgeContext : [];

  const deviceInfo = deviceType ? `设备类型：${deviceType}` : '设备类型：未指定';
  const knowledgeText = knowledgeContext.length
    ? `\n【参考知识库】\n${knowledgeContext.map((k, i) => `${i + 1}. ${k.title}：${k.summary}\n   可能原因：${(k.causes || []).join('、')}\n   解决措施：${(k.solutions || []).join('、')}`).join('\n')}`
    : '';

  const userMessage = `${deviceInfo}\n【故障现象】${symptom}${knowledgeText}\n\n请按照系统提示的 JSON 格式返回诊断结果，采用排除法进行推理分析。只返回 JSON，不要包含 markdown 代码块标记。`;

  const content = await callDeepSeek([
    { role: 'system', content: DIAGNOSE_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ], { temperature: 0.3, max_tokens: 2048, top_p: 0.9 });

  const result = extractJson(content);
  return json({
    id: 'ai-' + Date.now(),
    deviceType: deviceType || '通用',
    title: result.title || '故障诊断结果',
    symptoms: [symptom],
    keywords: result.causes?.map(c => c.name) || [],
    summary: result.summary || '',
    severity: result.severity || '中',
    shutdownRequired: Boolean(result.shutdownRequired),
    estimatedTime: result.estimatedTime || '',
    databaseMatch: Boolean(result.databaseMatch),
    databaseNote: result.databaseNote || '',
    causes: Array.isArray(result.causes) ? result.causes : [],
    eliminations: Array.isArray(result.eliminations) ? result.eliminations : [],
    rootCauses: Array.isArray(result.rootCauses) ? result.rootCauses : [],
    guidance: result.guidance || { steps: [], tools: [], prevention: '' },
    safety: result.safety || '',
    matchScore: result.matchScore || 85,
  });
}

async function aiParse(body) {
  if (!body || !body.text) return error('缺少 text 字段', 400);
  const text = String(body.text).slice(0, 20000);

  const content = await callDeepSeek([
    { role: 'system', content: PARSE_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ], { temperature: 0.2, max_tokens: 2048 });

  return json(extractJson(content));
}

async function aiTest() {
  await callDeepSeek([{ role: 'user', content: '回复：ok' }], { max_tokens: 10, temperature: 0 });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  { method: 'GET',    pattern: /^\/$/,                       handler: () => serviceInfo() },
  { method: 'GET',    pattern: /^\/health\/?$/,              handler: () => healthCheck() },
  { method: 'POST',   pattern: /^\/diagnose\/?$/,            handler: (body) => diagnose(body) },

  // Fault entries
  { method: 'GET',    pattern: /^\/faults\/?$/,              handler: () => listFaults() },
  { method: 'POST',   pattern: /^\/faults\/?$/,              handler: (body) => saveFaults(body) },
  { method: 'DELETE', pattern: /^\/faults\/?$/,              handler: () => clearFaults() },
  { method: 'DELETE', pattern: /^\/faults\/(.+)$/,           handler: (_, __, m) => deleteFault(m[1]) },

  // History
  { method: 'GET',    pattern: /^\/history\/search\/?$/,     handler: (_, q) => searchHistory(q) },
  { method: 'GET',    pattern: /^\/history\/count\/?$/,      handler: () => countHistory() },
  { method: 'GET',    pattern: /^\/history\/export\/?$/,     handler: () => exportHistory() },
  { method: 'GET',    pattern: /^\/history\/?$/,             handler: (_, q) => listHistory(q) },
  { method: 'POST',   pattern: /^\/history\/?$/,             handler: (body) => saveHistory(body) },
  { method: 'DELETE', pattern: /^\/history\/?$/,             handler: () => clearHistory() },
  { method: 'DELETE', pattern: /^\/history\/(.+)$/,          handler: (_, __, m) => deleteHistory(m[1]) },

  // Files
  { method: 'GET',    pattern: /^\/files\/?$/,               handler: () => listFiles() },
  { method: 'POST',   pattern: /^\/files\/?$/,               handler: (body) => markFile(body) },
  { method: 'DELETE', pattern: /^\/files\/?$/,               handler: () => clearFiles() },

  // AI (DeepSeek) proxy
  { method: 'GET',    pattern: /^\/ai\/status\/?$/,          handler: () => aiStatus() },
  { method: 'POST',   pattern: /^\/ai\/diagnose\/?$/,        handler: (body) => aiDiagnose(body) },
  { method: 'POST',   pattern: /^\/ai\/parse\/?$/,           handler: (body) => aiParse(body) },
  { method: 'POST',   pattern: /^\/ai\/test\/?$/,            handler: () => aiTest() },
];

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase();
  const path = normalizePath(req.url);
  const query = parseQuery(req.url);
  const cors = corsHeaders();

  console.log(`[cloudbase] ${method} ${path}`);

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const rawBody = await readBody(req);
  const body = parseBody(rawBody);

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;

    try {
      const result = await route.handler(body, query, match);
      res.writeHead(result.statusCode ?? 200, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(result.data));
      return;
    } catch (e) {
      console.error('[cloudbase]', e);
      const status = Number(e.status) || 500;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message || 'Internal server error' }));
      return;
    }
  }

  res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[cloudbase] listening on 0.0.0.0:${PORT}`);
});
