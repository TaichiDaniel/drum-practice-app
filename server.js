const express = require("express");
const path = require("path");
// const fetch = require("node-fetch"); // Node 18+ 可用全域 fetch，也可用 node-fetch
const { Pinecone, ServerlessSpec } = require("@pinecone-database/pinecone");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // 提供前端靜態檔案

// 讀取環境變數
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENV = process.env.PINECONE_ENV;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

// 初始化 Pinecone 客戶端
const pc = new Pinecone({
  apiKey: PINECONE_API_KEY,
  // controllerHostUrl: "https://controller.us-east-1-aws.pinecone.io" // 依照你的 env region 改
});

// 取得 Pinecone Index 實例
const pineconeIndex = pc.Index(PINECONE_INDEX_NAME);

console.log("🔍 Pinecone index:", PINECONE_INDEX_NAME);
console.log("🔍 Pinecone env:", PINECONE_ENV);
console.log("🔍 Controller URL:", "https://controller.us-east-1.pinecone.io");

// 初始化 OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// POST /gpt 路由：接收前端輸入文字，查 Pinecone，再送給 GPT
app.post("/gpt", async (req, res) => {

  /* 測試前端fetch("/gpt") 是否能正常呼叫後端，以及後端 route 是否能回傳 JSON
  console.log("測試收到請求", req.body);
  res.json({ reply: "後端測試成功！" });
  */

  const userText = req.body.text;
  console.log("收到練習內容：", userText);

  try {
  // -----------------------------
  // 1️⃣ 先呼叫 OpenAI Embeddings 生成向量
  // -----------------------------
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: userText
  });

  // ✅ 直接取回 JS object，不要再 .json()
  const userVector = embeddingResponse.data[0].embedding;

  // -----------------------------
  // 2️⃣ 查詢 Pinecone
  // -----------------------------
  const queryResponse = await pineconeIndex.query({
    vector: userVector,
    topK: 3, // 取最相似的前三個段落
    includeMetadata: true
  });

  console.log("Pinecone 查詢結果：", JSON.stringify(queryResponse, null, 2));

  // 回傳查到的段落 (先測試 Pinecone)
  const matchedTexts = queryResponse.matches.map(m => m.metadata.text);
  res.json({
    reply: "Pinecone 查詢測試成功！\n\n找到的段落：\n" + matchedTexts.join("\n---\n")
  });

  } catch (err) {
    console.error("發生錯誤：", err);
    res.status(500).json({ reply: "❌ 發生錯誤，請稍後再試\n\n" + err.message });
  }
});

  /* 
  try {
    // 1️⃣ 先用 OpenAI 的 embedding 生成向量
    const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: userText
      })
    });

    const embeddingData = await embeddingResponse.json();
    const userEmbedding = embeddingData.data[0].embedding; // 取出向量
    console.log("使用者向量生成完成");

    // 2️⃣ 查詢 Pinecone 找最相似的教材
    const queryResponse = await pineconeIndex.query({
      vector: userEmbedding,
      topK: 3, // 取得最相似的 3 筆
      includeMetadata: true
    });

    // 把找到的段落內容組成 GPT prompt
    let contextText = "";
    queryResponse.matches.forEach((match, idx) => {
      contextText += `段落 ${idx + 1}: ${match.metadata.text}\n`;
    });

    console.log("從 Pinecone 取出的相似教材：", contextText);

    // 3️⃣ 把使用者輸入 + 相似教材送給 GPT 生成回答
    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "你是一位在 MI 教導鼓 Technique 的老師，幫使用者把練習內容整理成鼓勵語句" },
          { role: "user", content: `教材參考:\n${contextText}\n使用者練習內容:\n${userText}` }
        ]
      })
    });

    const gptData = await gptResponse.json();
    const reply = gptData.choices[0].message.content;

    console.log("GPT 回覆：", reply);

    res.json({ reply });

  } catch (err) {
    console.error("後端發生錯誤：", err);
    res.status(500).json({ error: "伺服器或 GPT/Pinecone API 發生錯誤" });
  }
    
});
*/


// Heroku port 設定
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// 簡單 ping 測試
app.get("/ping", (req, res) => {
  res.send("pong");
});
