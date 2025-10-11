// ----------------------------
// 套件匯入
// ----------------------------
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import faiss from "faiss-node"; // 用於載入 index 檔
import OpenAI from "openai";

dotenv.config();

// ----------------------------
// 初始化 Express 伺服器
// ----------------------------
const app = express();
app.use(express.json());

// ----------------------------
// 初始化 OpenAI
// ----------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ----------------------------
// 各類別的向量資料庫 (載入後會放在這裡)
// 格式：
// databases = {
//   rock: { index: <faiss index>, docs: [ ...文字段落... ] },
//   jazz: { index: <faiss index>, docs: [ ...文字段落... ] }
// }
// ----------------------------
let databases = {};

// ----------------------------
// 1️⃣ Dyno 啟動時：從 Google Drive 下載 index + json
// ----------------------------
async function loadVectorDBfromGoogleDrive() {
  console.log("🔄 正在從 Google Drive 載入向量資料庫...");

  const fileIds = {
    index: "你的_index_file_id", // ← 這裡換成你的 Google Drive 檔案 ID
    json: "你的_json_file_id"   // ← 這裡換成你的 Google Drive 檔案 ID
  };

  try {
    // 下載 index 檔（二進位）
    const indexRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileIds.index}?alt=media`,
      { headers: { "Authorization": `Bearer ${process.env.GOOGLE_DRIVE_TOKEN}` } }
    );
    const indexBuffer = await indexRes.arrayBuffer();

    // 下載 json 檔（文字）
    const jsonRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileIds.json}?alt=media`,
      { headers: { "Authorization": `Bearer ${process.env.GOOGLE_DRIVE_TOKEN}` } }
    );
    const jsonBuffer = await jsonRes.arrayBuffer();

    // 寫入 Heroku 的暫存檔案系統
    fs.writeFileSync("local_index.bin", Buffer.from(indexBuffer));
    fs.writeFileSync("local_data.json", Buffer.from(jsonBuffer));

    console.log("✅ 向量資料庫下載完成！");
  } catch (err) {
    console.error("❌ Google Drive 載入錯誤：", err);
  }
}

// ----------------------------
// 2️⃣ 載入 index + json 進記憶體
// ----------------------------
async function loadDatabases() {
  console.log("📥 開始載入本地 index + json ...");
  try {
    const indexBuffer = fs.readFileSync("local_index.bin");
    const jsonString = fs.readFileSync("local_data.json", "utf-8");
    const jsonData = JSON.parse(jsonString);

    // 初始化 FAISS index
    const index = faiss.readIndexBinary(indexBuffer);

    // 將資料存入全域變數 databases（假設目前只有一個分類）
    databases["教材"] = {
      index,
      docs: jsonData.docs // 假設 json 裡面是 { docs: [ "段落1", "段落2", ... ] }
    };

    console.log("✅ 資料庫載入完成，段落數量：", jsonData.docs.length);
  } catch (err) {
    console.error("❌ 載入本地資料時出錯：", err);
  }
}

// ----------------------------
// 3️⃣ 問題檢索 + GPT 回答
// ----------------------------
app.post("/gpt", async (req, res) => {
  const userText = req.body.text;

  try {
    // (1) 建立使用者問題的向量
    const embeddingResp = await client.embeddings.create({
      model: "text-embedding-ada-002",
      input: userText
    });
    let q_emb = embeddingResp.data[0].embedding;
    q_emb = new Float32Array(q_emb);
    const q_emb_2d = [q_emb]; // faiss.search() 需要二維陣列

    // (2) 找最相關的大類別（目前假設只有一個分類 "教材"）
    const categoryScores = {};
    for (const cat in databases) {
      const { index } = databases[cat];
      const [D, I] = index.search(q_emb_2d, 1); // 搜尋最相似的一筆
      categoryScores[cat] = D[0][0];
    }

    const selected_cat = Object.keys(categoryScores).reduce((a, b) =>
      categoryScores[a] < categoryScores[b] ? a : b
    );

    // (3) 從選定類別檢索 top 3 段落
    const data = databases[selected_cat];
    const [D, I] = data.index.search(q_emb_2d, 3);
    const relevant_texts = I[0].map(idx => data.docs[idx]);

    // (4) 組成 prompt 給 GPT 模型
    const prompt = `以下是 ${selected_cat} 類別教材內容：\n${relevant_texts.join(
      "\n"
    )}\n\n請只根據上面的教材回答問題。如果教材中沒有答案，請回答「教材中沒有相關資訊」。\n問題：${userText}\n回答：`;

    // (5) 呼叫 GPT API 回答
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const dataResp = await response.json();
    const reply = dataResp.choices[0].message.content;

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "伺服器或 GPT API 發生錯誤" });
  }
});

// ----------------------------
// 4️⃣ 啟動伺服器（自動下載 + 載入）
// ----------------------------
const PORT = process.env.PORT || 3000;

(async () => {
  await loadVectorDBfromGoogleDrive(); // 從雲端載入
  await loadDatabases();                // 載入到記憶體
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
})();
