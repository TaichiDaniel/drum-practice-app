// ======= 基本設定 =======
const express = require("express");
const path = require("path");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======= 讀取環境變數 =======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ======= GPT 測試路由 =======
app.post("/gpt", async (req, res) => {
  const userText = req.body.text || "";
  console.log("\n❓ 使用者輸入:", userText);

  try {
    // ✅ 只呼叫 gpt-5-mini，不加任何額外 prompt 或 Pinecone 查詢
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are ChatGPT, a helpful assistant." },
        { role: "user", content: userText },
      ],
      // ⚠️ 不加 temperature，因為 gpt-5-mini 只支援預設值 1
      max_tokens: 500,
    });

    const reply = completion.choices[0].message.content;
    console.log("✅ 模型回覆:", reply);

    res.json({ reply });
  } catch (err) {
    console.error("❌ 發生錯誤：", err);
    res.status(500).json({
      reply: "❌ 發生錯誤，請稍後再試\n\n" + err.message,
    });
  }
});

// ======= 健康檢查與伺服器啟動 =======
app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
