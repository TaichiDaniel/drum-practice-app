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

// ==================== 步驟 1: 問題分析器 ====================

const QUERY_ANALYZER_PROMPT = `你是爵士鼓教材助手的查詢分析器。分析使用者問題，判斷問題類型並提取關鍵資訊。

問題類型：
1. **metadata_query**: 需要查詢結構性資訊（如：有幾個單元、目錄、章節列表）
2. **content_search**: 需要搜尋具體內容（如：如何練習、技巧說明）
3. **specific_chapter**: 詢問特定章節內容
4. **general_question**: 一般性問題

教材結構：
- 類別: Technique, Reading, Performance
- 級別: Level 1-4
- 單元: Unit 1-10
- 章節: Chapter 1-N

請以 JSON 格式回應：
{
    "query_type": "metadata_query|content_search|specific_chapter|general_question",
    "category": "Technique|Reading|Performance|null",
    "level": "1|2|3|4|null",
    "unit": "unit number or null",
    "chapter": "chapter number or null",
    "keywords": ["關鍵字1", "關鍵字2"],
    "search_query": "用於向量搜尋的英文查詢",
    "reasoning": "判斷理由"
}

範例：

問題: "告訴我Technique Level 1有幾個單元？"
回應:
{
    "query_type": "metadata_query",
    "category": "Technique",
    "level": "1",
    "unit": null,
    "chapter": null,
    "keywords": ["unit", "count"],
    "search_query": "Technique Level 1 units structure",
    "reasoning": "詢問結構性資訊"
}

問題: "如何練習 Gladstone 技巧？"
回應:
{
    "query_type": "content_search",
    "category": "Technique",
    "level": null,
    "unit": null,
    "chapter": null,
    "keywords": ["gladstone", "practice"],
    "search_query": "gladstone technique practice methods",
    "reasoning": "詢問具體技巧內容"
}

現在請分析以下問題：`;

async function analyzeQuery(userQuery) {
  console.log("\n🔍 步驟 1: 分析問題...");
  
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: QUERY_ANALYZER_PROMPT },
      { role: "user", content: userQuery }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  });
  
  const analysis = JSON.parse(response.choices[0].message.content);
  
  console.log(`   類型: ${analysis.query_type}`);
  console.log(`   類別: ${analysis.category || 'N/A'}`);
  console.log(`   級別: Level ${analysis.level || 'N/A'}`);
  console.log(`   理由: ${analysis.reasoning}`);
  
  return analysis;
}

// ==================== 步驟 2: 智能查詢策略 ====================

async function queryMetadata(analysis) {
  console.log("\n📊 步驟 2a: 執行 metadata 查詢...");
  
  // 建立過濾條件
  const filter = {};
  if (analysis.category) filter.category = analysis.category;
  if (analysis.level) filter.level = String(analysis.level);
  
  // 使用 dummy vector 觸發 metadata 過濾
  const dummyVector = new Array(1536).fill(0);
  
  const results = await pineconeIndex.query({
    vector: dummyVector,
    topK: 100,
    includeMetadata: true,
    filter: Object.keys(filter).length > 0 ? filter : undefined
  });
  
  // 分析結構
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
  
  // 去重並排序
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
  
  // 生成 embedding
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: analysis.search_query
  });
  
  const queryVector = embeddingResponse.data[0].embedding;
  
  // 建立過濾條件
  const filter = {};
  if (analysis.category) filter.category = analysis.category;
  if (analysis.level) filter.level = String(analysis.level);
  if (analysis.unit) filter.unit = analysis.unit;
  if (analysis.chapter) filter.chapter = analysis.chapter;
  
  // 查詢
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

async function routeQuery(analysis) {
  const queryType = analysis.query_type;
  
  if (queryType === 'metadata_query') {
    return await queryMetadata(analysis);
  } else if (['content_search', 'specific_chapter'].includes(queryType)) {
    return await searchContent(analysis);
  } else {
    // general_question - 預設用內容搜尋
    return await searchContent(analysis);
  }
}

// ==================== 步驟 3: 生成答案 ====================

const ANSWER_GENERATOR_PROMPT = `你是一位在 Musician Institute 教導爵士鼓的專業老師，熟悉 Technique、Reading 和 Performance 教材內容。

回答原則：
1. 如果是結構性問題（如有幾個單元），直接從 metadata 統計回答
2. 如果是內容問題，基於檢索到的文本內容回答
3. 保持專業但友善的語氣
4. 如果資料不足，誠實說明
5. 用繁體中文回答
6. 不需要額外的鼓勵話語

請根據以下檢索資料回答使用者問題。`;

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
  } else {
    // content
    let formatted = "相關內容：\n\n";
    
    retrievedData.results.forEach((match, i) => {
      const meta = match.metadata;
      formatted += `【資料 ${i + 1}】\n`;
      formatted += `來源: ${meta.book || 'N/A'} - Unit ${meta.unit || 'N/A'} - Chapter ${meta.chapter || 'N/A'}\n`;
      formatted += `標題: ${meta.chapter_title || 'N/A'}\n`;
      formatted += `內容: ${(meta.text || '').substring(0, 500)}...\n`;
      formatted += `相似度: ${match.score.toFixed(3)}\n\n`;
    });
    
    return formatted;
  }
}

async function generateAnswer(userQuery, retrievedData) {
  console.log("\n💬 步驟 3: 生成答案...");
  
  const formattedData = formatRetrievedData(retrievedData);
  
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      { role: "system", content: ANSWER_GENERATOR_PROMPT },
      { 
        role: "user", 
        content: `檢索資料：\n${formattedData}\n\n使用者問題：${userQuery}\n\n請回答：`
      }
    ],
    temperature: 0.7
  });
  
  return response.choices[0].message.content;
}

// ==================== 主路由：Agentic RAG ====================

app.post("/gpt", async (req, res) => {
  const userText = req.body.text;
  console.log("\n" + "=".repeat(60));
  console.log("❓ 使用者問題:", userText);
  console.log("=".repeat(60));
  
  try {
    // 步驟 1: 分析問題
    const analysis = await analyzeQuery(userText);
    
    // 步驟 2: 查詢資料
    const retrievedData = await routeQuery(analysis);
    
    // 步驟 3: 生成答案
    const answer = await generateAnswer(userText, retrievedData);
    
    console.log("\n✅ 回答:", answer);
    console.log("=".repeat(60) + "\n");
    
    res.json({ reply: answer });
    
  } catch (err) {
    console.error("❌ 發生錯誤：", err);
    res.status(500).json({ 
      reply: "❌ 發生錯誤，請稍後再試\n\n" + err.message 
    });
  }
});

// ==================== 其他路由 ====================

// Heroku port 設定
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// 簡單 ping 測試
app.get("/ping", (req, res) => {
  res.send("pong");
});

// 健康檢查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    pinecone: PINECONE_INDEX_NAME,
    timestamp: new Date().toISOString()
  });
});