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

// -----------------------------
// 🈶 自動偵測中文 → 翻譯成英文
// -----------------------------
let processedText = userText;

if (/[\u4e00-\u9fa5]/.test(userText)) {  // 偵測是否含中文
  console.log("🔁 偵測到中文，正在翻譯成英文以利向量比對...");

  try {
    const translation = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: "You are a translator that accurately translates Chinese text to English for semantic search on drum education materials."
        },
        { role: "user", content: userText }
      ]
    });

    processedText = translation.choices[0].message.content.trim();
    console.log("✅ 翻譯完成：", processedText);
  } catch (e) {
    console.error("⚠️ 翻譯失敗，改用原始輸入：", e.message);
  }
}

  try {
  // -----------------------------
  // 1️⃣ 先呼叫 OpenAI Embeddings 生成向量
  // -----------------------------
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: processedText
  });

  // ✅ 直接取回 JS object，不要再 .json()
  const userVector = embeddingResponse.data[0].embedding;

  // -----------------------------
  // 2️⃣ 查詢 Pinecone
  // -----------------------------
  const queryResponse = await pineconeIndex.query({
    vector: userVector,
    topK: 5, // 取最相似的前三個段落
    includeMetadata: true
  });

  console.log("Pinecone 查詢結果：", JSON.stringify(queryResponse, null, 2));

  // -----------------------------
  // 3️⃣ 整理查到的段落內容
  // -----------------------------
  const matchedTexts = queryResponse.matches.map(m => m.metadata.text);
  const contextText = matchedTexts.join("\n---\n");
/*
  let prompt = "";
  if (matchedTexts.length > 0) {
    prompt =
    
      `以下是教材內容的部分摘錄：\n\n` +
      matchedTexts.join("\n\n---\n\n") +
      `\n\n請只根據上面的教材回答問題。` +
      `如果教材中沒有答案，請回答「教材中沒有相關資訊」。\n\n` +
      `問題：${userText}\n回答：`;
    
      prompt =
      `以下是教材內容的部分摘錄：\n\n` +
      matchedTexts.join("\n\n---\n\n") +
      `\n\n請以100%教材查到的內容回答問題。` +
      `問題：${userText}\n回答：`;
  } else {
    prompt =
      `教材中沒有相關資訊。\n\n` +
      `問題：${userText}\n回答：`;
  }
*/
    // -----------------------------
    // 4️⃣ 呼叫 GPT 產生回覆
    // -----------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: "你是一位在 Musician Institute 教導爵士鼓的老師，熟悉Technique、Reading和Performance教材內容。請根據教材內容回答使用者的問題。不需要鼓勵的話。"
        },
        {
          role: "user",
          content: 
            `以下是教材內容的部分摘錄：\n\n${contextText}\n\n` +
            `請根據教材回答問題。若教材中沒有提到，請回答「教材中沒有相關資訊」。\n\n` +
            `學生的問題：${userText}`
          
        }
      ]
    });

    const gptReply = completion.choices[0].message.content;

    console.log("GPT 回覆：", gptReply);

    // -----------------------------
    // 5️⃣ 回傳最終結果給前端
    // -----------------------------
    res.json({
      reply: gptReply
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
