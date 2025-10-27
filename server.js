const express = require("express");
const path = require("path");
const { Pinecone } = require("@pinecone-database/pinecone");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 讀取環境變數
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

// 初始化客戶端
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const pineconeIndex = pc.Index(PINECONE_INDEX_NAME);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("🔍 Pinecone index:", PINECONE_INDEX_NAME);

// ==================== 新增：對話記憶管理 ====================
// 儲存每個使用者的對話歷史（使用 session ID）
const conversationMemory = new Map();
const MAX_HISTORY_LENGTH = 10; // 最多記住 10 輪對話

function getConversationHistory(sessionId) {
  if (!conversationMemory.has(sessionId)) {
    conversationMemory.set(sessionId, []);
  }
  return conversationMemory.get(sessionId);
}

function addToHistory(sessionId, role, content) {
  const history = getConversationHistory(sessionId);
  history.push({ role, content, timestamp: new Date() });
  
  // 限制歷史長度
  if (history.length > MAX_HISTORY_LENGTH * 2) {
    history.shift(); // 移除最舊的
    history.shift();
  }
  
  console.log(`   💾 已儲存對話 (${role}), 歷史長度: ${history.length}`);
}

function clearHistory(sessionId) {
  conversationMemory.delete(sessionId);
  console.log(`   🗑️ 已清除 session ${sessionId} 的歷史`);
}

// ==================== 步驟 1: 問題分析器（增強版）====================

const QUERY_ANALYZER_PROMPT = `你是爵士鼓教材助手的查詢分析器。分析使用者問題，判斷問題類型並提取關鍵資訊。

問題類型：
1. **metadata_query**: 需要查詢結構性資訊（如：有幾個單元、目錄、章節列表）
2. **content_search**: 需要搜尋具體內容（如：如何練習、技巧說明）
3. **specific_chapter**: 詢問特定章節內容
4. **level_recommendation**: 詢問適合的程度/級別建議（需要查詢多個類別）
5. **general_question**: 一般性問題

教材結構：
- 類別: Technique, Reading, Performance
- 級別: Level 1-4
- 單元: Unit 1-10
- 章節: Chapter 1-N

請以 JSON 格式回應：
{
    "query_type": "metadata_query|content_search|specific_chapter|level_recommendation|general_question",
    "category": "Technique|Reading|Performance|all|null",
    "level": "1|2|3|4|null",
    "unit": "unit number or null",
    "chapter": "chapter number or null",
    "keywords": ["關鍵字1", "關鍵字2"],
    "search_query": "用於向量搜尋的英文查詢",
    "reasoning": "判斷理由"
}

特別注意：
- 如果問題涉及「我的程度」、「適合我的教材」、「該學什麼」→ query_type 設為 "level_recommendation"，category 設為 "all"
- level_recommendation 類型需要同時查詢 Technique, Reading, Performance 三類教材

範例：

問題: "我打鼓兩年了，該做什麼練習？"
回應:
{
    "query_type": "level_recommendation",
    "category": "all",
    "level": null,
    "unit": null,
    "chapter": null,
    "keywords": ["practice", "intermediate", "progress"],
    "search_query": "intermediate level practice recommendations",
    "reasoning": "詢問程度相關建議，需要查詢所有類別教材"
}

現在請分析以下問題：`;

async function analyzeQuery(userQuery, conversationHistory = []) {
  console.log("\n🔍 步驟 1: 分析問題...");
  
  // 新增：包含對話歷史
  const messages = [
    { role: "system", content: QUERY_ANALYZER_PROMPT }
  ];
  
  // 加入最近 3 輪對話作為上下文
  const recentHistory = conversationHistory.slice(-6); // 最近 3 輪（6 則訊息）
  messages.push(...recentHistory);
  
  messages.push({ role: "user", content: userQuery });
  
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: messages,
    response_format: { type: "json_object" },
    // temperature: 0
  });
  
  const analysis = JSON.parse(response.choices[0].message.content);
  
  console.log(`   類型: ${analysis.query_type}`);
  console.log(`   類別: ${analysis.category || 'N/A'}`);
  console.log(`   級別: Level ${analysis.level || 'N/A'}`);
  console.log(`   理由: ${analysis.reasoning}`);
  
  return analysis;
}

// ==================== 新增：使用者背景分析 ====================

async function analyzeUserContext(userQuery, conversationHistory = []) {
  console.log("\n👤 分析使用者背景...");
  
  const messages = [
    { 
      role: "system", 
      content: "分析使用者的爵士鼓程度和需求，回傳 JSON：{\"level\": \"beginner|intermediate|advanced\", \"experience_years\": number|null, \"goals\": [string], \"challenges\": [string], \"suitable_book_level\": number|null}"
    }
  ];
  
  // 包含對話歷史
  const recentHistory = conversationHistory.slice(-4);
  messages.push(...recentHistory);
  messages.push({ role: "user", content: userQuery });
  
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: messages,
    response_format: { type: "json_object" },
    // temperature: 0,
    // max_tokens: 200
  });
  
  const context = JSON.parse(response.choices[0].message.content);
  console.log(`   程度: ${context.level}`);
  console.log(`   經驗: ${context.experience_years || 'N/A'} 年`);
  console.log(`   適合級別: Level ${context.suitable_book_level || 'N/A'}`);
  
  return context;
}

// ==================== 步驟 2: 智能查詢策略（增強版）====================

async function queryMetadata(analysis) {
  console.log("\n📊 步驟 2a: 執行 metadata 查詢...");
  
  const filter = {};
  if (analysis.category && analysis.category !== 'all') {
    filter.category = analysis.category;
  }
  if (analysis.level) filter.level = String(analysis.level);
  
  const dummyVector = new Array(1536).fill(0);
  
  const results = await pineconeIndex.query({
    vector: dummyVector,
    topK: 100,
    includeMetadata: true,
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });
  
  const units = new Set();
  const chaptersByUnit = {};
  
  results.matches.forEach(match => {
    const meta = match.metadata;
    const unit = meta.unit;
    const chapter = meta.chapter;
    
    if (unit) {
      units.add(unit);
      if (!chaptersByUnit[unit]) {
        chaptersByUnit[unit] = [];
      }
      if (chapter) {
        chaptersByUnit[unit].push({
          chapter: chapter,
          title: meta.chapter_title || ''
        });
      }
    }
  });
  
  Object.keys(chaptersByUnit).forEach(unit => {
    const seen = new Set();
    const unique = [];
    chaptersByUnit[unit].forEach(ch => {
      if (!seen.has(ch.chapter)) {
        seen.add(ch.chapter);
        unique.push(ch);
      }
    });
    chaptersByUnit[unit] = unique.sort((a, b) => a.chapter - b.chapter);
  });
  
  console.log(`   找到 ${units.size} 個 Units`);
  
  return {
    type: 'metadata',
    totalUnits: units.size,
    units: Array.from(units).sort((a, b) => a - b),
    chaptersByUnit: chaptersByUnit,
    rawResults: results.matches.slice(0, 5)
  };
}

async function searchContent(analysis) {
  console.log("\n🔍 步驟 2b: 執行向量搜尋...");
  
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: analysis.search_query
  });
  
  const queryVector = embeddingResponse.data[0].embedding;
  
  const filter = {};
  if (analysis.category && analysis.category !== 'all') {
    filter.category = analysis.category;
  }
  if (analysis.level) filter.level = String(analysis.level);
  if (analysis.unit) filter.unit = analysis.unit;
  if (analysis.chapter) filter.chapter = analysis.chapter;
  
  const results = await pineconeIndex.query({
    vector: queryVector,
    topK: 5,
    includeMetadata: true,
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });
  
  console.log(`   找到 ${results.matches.length} 個相關段落`);
  
  return {
    type: 'content',
    results: results.matches
  };
}

// 新增：多類別查詢（針對程度建議）
async function searchMultiCategory(analysis, userContext) {
  console.log("\n🎯 步驟 2c: 執行多類別查詢...");
  
  const categories = ['Technique', 'Reading', 'Performance'];
  const allResults = {};
  
  // 根據使用者程度決定查詢的 Level
  const targetLevel = userContext.suitable_book_level || 
                     (userContext.level === 'beginner' ? 1 : 
                      userContext.level === 'intermediate' ? 2 : 3);
  
  console.log(`   目標級別: Level ${targetLevel}`);
  
  for (const category of categories) {
    console.log(`   查詢 ${category}...`);
    
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: `${category} practice exercises level ${targetLevel}`
    });
    
    const queryVector = embeddingResponse.data[0].embedding;
    
    const results = await pineconeIndex.query({
      vector: queryVector,
      topK: 3, // 每個類別取前 3 名
      includeMetadata: true,
      filter: {
        category: category,
        level: String(targetLevel)
      }
    });
    
    allResults[category] = {
      results: results.matches,
      targetLevel: targetLevel
    };
    
    console.log(`     ${category}: 找到 ${results.matches.length} 個段落`);
  }
  
  return {
    type: 'multi_category',
    categories: allResults,
    targetLevel: targetLevel
  };
}

async function routeQuery(analysis, userContext) {
  const queryType = analysis.query_type;
  
  if (queryType === 'metadata_query') {
    return await queryMetadata(analysis);
  } else if (queryType === 'level_recommendation') {
    // 新增：多類別查詢
    return await searchMultiCategory(analysis, userContext);
  } else if (['content_search', 'specific_chapter'].includes(queryType)) {
    return await searchContent(analysis);
  } else {
    return await searchContent(analysis);
  }
}

// ==================== 步驟 3: 生成答案（完整增強版）====================

const ANSWER_GENERATOR_PROMPT = `你是一位在 Musician Institute 教導爵士鼓的專業老師，擅長根據學生程度提供個人化建議。

## 回答原則：
1. **分析使用者背景**：從問題中提取程度、目標、困難點
2. **教材為基礎，經驗為補充**：
   - 優先使用檢索到的教材內容
   - 如果教材不足，基於專業經驗補充
3. **結構化呈現**：使用 Markdown 格式，清晰分層
4. **具體可執行**：
   - 提供明確的練習項目
   - 包含 BPM/時間/次數等具體數字
   - 明確指出教材章節
5. **個人化**：根據使用者程度調整難度
6. **用繁體中文回答**

## 針對程度建議類問題的特殊格式：
當查詢類型為 "level_recommendation" 時，必須提供三大類別建議：

**[程度判斷]**（一句話）

根據你的程度，建議從 Level X 開始，以下是三大類別的練習建議：

### 🎵 Technique（技術訓練）
**推薦級別**：Level X
**核心章節**：
- Unit Y Chapter Z: [章節名]
  - 練習重點：[具體說明]
  - 建議練習：[BPM/時間]

### 📖 Reading（讀譜能力）
**推薦級別**：Level X
**核心章節**：
- Unit Y Chapter Z: [章節名]
  - 練習重點：[具體說明]

### 🎭 Performance（演奏表現）
**推薦級別**：Level X
**核心章節**：
- Unit Y Chapter Z: [章節名]
  - 練習重點：[具體說明]

### ⏰ 每日練習建議（總時間 60-90 分鐘）
| 時間 | 類別 | 內容 |
|------|------|------|
| 20分 | Technique | [具體練習] |
| 20分 | Reading | [具體練習] |
| 20分 | Performance | [具體練習] |
| 10分 | 自由練習 | [建議方向] |

---

💭 **想要更具體的建議？**
告訴我：
- 你主要想練什麼風格？（Rock / Jazz / Funk / Pop）
- 你有什麼設備？（電子鼓 / 原聲鼓 / 練習墊）
- 每天可以練習多久？

---

請根據以下資料回答：`;

function formatRetrievedData(retrievedData) {
  if (retrievedData.type === 'metadata') {
    let formatted = `
結構資訊：
- 總單元數: ${retrievedData.totalUnits}
- 單元列表: ${retrievedData.units.map(u => `Unit ${u}`).join(', ')}

各單元章節：
`;
    
    retrievedData.units.sort((a, b) => a - b).forEach(unit => {
      formatted += `\nUnit ${unit}:\n`;
      const chapters = retrievedData.chaptersByUnit[unit] || [];
      chapters.forEach(ch => {
        formatted += `  - Chapter ${ch.chapter}: ${ch.title}\n`;
      });
    });
    
    return formatted;
  } else if (retrievedData.type === 'multi_category') {
    // 新增：格式化多類別查詢結果
    let formatted = `\n## 多類別教材檢索結果（Level ${retrievedData.targetLevel}）\n\n`;
    
    Object.keys(retrievedData.categories).forEach(category => {
      const categoryData = retrievedData.categories[category];
      formatted += `### ${category} 教材\n`;
      formatted += `目標級別: Level ${categoryData.targetLevel}\n\n`;
      
      categoryData.results.forEach((match, i) => {
        const meta = match.metadata;
        formatted += `【${category} ${i + 1}】${meta.book || ''}\n`;
        formatted += `Unit ${meta.unit || 'N/A'} - Chapter ${meta.chapter || 'N/A'}: ${meta.chapter_title || 'N/A'}\n`;
        formatted += `內容摘要: ${(meta.text || '').substring(0, 300)}...\n`;
        formatted += `相似度: ${(match.score * 100).toFixed(1)}%\n\n`;
      });
      
      formatted += `---\n\n`;
    });
    
    return formatted;
  } else {
    // content
    let formatted = "相關教材內容：\n\n";
    
    retrievedData.results.forEach((match, i) => {
      const meta = match.metadata;
      formatted += `【教材 ${i + 1}】${meta.book || ''} - Unit ${meta.unit || 'N/A'} - Chapter ${meta.chapter || 'N/A'}\n`;
      formatted += `📖 標題: ${meta.chapter_title || 'N/A'}\n`;
      formatted += `📝 內容:\n${(meta.text || '').substring(0, 600)}\n`;
      formatted += `🎯 相似度: ${(match.score * 100).toFixed(1)}%\n`;
      formatted += `---\n\n`;
    });
    
    return formatted;
  }
}

async function generateAnswer(userQuery, retrievedData, userContext, conversationHistory = []) {
  console.log("\n💬 步驟 3: 生成個人化答案...");
  
  const formattedData = formatRetrievedData(retrievedData);
  
  const enhancedPrompt = `
## 使用者背景
- 程度: ${userContext.level}
- 經驗: ${userContext.experience_years || '未知'} 年
- 目標: ${userContext.goals.join(', ') || '未指定'}
- 挑戰: ${userContext.challenges.join(', ') || '未指定'}
- 適合級別: Level ${userContext.suitable_book_level || '待評估'}

## 檢索到的教材
${formattedData}

## 對話歷史
${conversationHistory.length > 0 ? '（使用者之前提過：' + conversationHistory.slice(-2).map(h => h.content).join('；') + '）' : '（首次對話）'}

## 使用者問題
${userQuery}

---

請根據使用者程度，結合教材內容，提供結構化的個人化建議。
${retrievedData.type === 'multi_category' ? '⚠️ 這是程度建議問題，請務必包含 Technique、Reading、Performance 三大類別的建議。' : ''}
如果教材內容不足以完整回答，請基於專業經驗補充，但要明確區分「教材內容」和「專業建議」。
`;
  
  const messages = [
    { role: "system", content: ANSWER_GENERATOR_PROMPT },
    { role: "user", content: enhancedPrompt }
  ];
  
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: messages,
    // temperature: 0.8,
    // max_tokens: 2000  // 增加以容納多類別建議
  });
  
  return response.choices[0].message.content;
}

// ==================== 主路由（完整版）====================

app.post("/gpt", async (req, res) => {
  const userText = req.body.text;
  const sessionId = req.body.sessionId || 'default'; // 前端提供 session ID
  
  console.log("\n" + "=".repeat(60));
  console.log("❓ 使用者問題:", userText);
  console.log("🆔 Session ID:", sessionId);
  console.log("=".repeat(60));
  
  try {
    // 取得對話歷史
    const conversationHistory = getConversationHistory(sessionId);
    
    // 步驟 0: 分析使用者背景
    const userContext = await analyzeUserContext(userText, conversationHistory);
    
    // 步驟 1: 分析問題（包含歷史）
    const analysis = await analyzeQuery(userText, conversationHistory);
    
    // 步驟 2: 查詢資料
    const retrievedData = await routeQuery(analysis, userContext);
    
    // 步驟 3: 生成答案（包含歷史）
    const answer = await generateAnswer(userText, retrievedData, userContext, conversationHistory);
    
    // 儲存對話歷史
    addToHistory(sessionId, 'user', userText);
    addToHistory(sessionId, 'assistant', answer);
    
    console.log("\n✅ 回答:", answer.substring(0, 200) + "...");
    console.log("=".repeat(60) + "\n");
    
    res.json({ 
      reply: answer,
      sessionId: sessionId,
      conversationCount: conversationHistory.length / 2
    });
    
  } catch (err) {
    console.error("❌ 發生錯誤：", err);
    res.status(500).json({ 
      reply: "❌ 發生錯誤，請稍後再試\n\n" + err.message 
    });
  }
});

// 新增：清除對話歷史 API
app.post("/clear-history", (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  clearHistory(sessionId);
  res.json({ message: "對話歷史已清除", sessionId: sessionId });
});

// ==================== 其他路由 ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

app.get("/ping", (req, res) => res.send("pong"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    pinecone: PINECONE_INDEX_NAME,
    activesessions: conversationMemory.size,
    timestamp: new Date().toISOString()
  });
});