import express from "express";
import bodyParser from "body-parser";

const app = express();
const PORT = 3000;

// 靜態檔案服務
app.use(express.static("."));
app.use(bodyParser.json());

// Gemini API 設定
const GEMINI_API_KEY = "AIzaSyBbHHa-dXrPbZGcSdN5NsqBQK1-2iRtkQY";
const MODEL = "gemini-1.5-flash";
const LOCATION = "asia-east1"; // 台灣用這個
const PROJECT_ID = "gen-lang-client-0080675308"

app.post("/generate", async (req, res) => {
  try {
    const userInput = req.body.text; // 🔹 跟前端一致
    console.log("收到練習內容：", userInput);

    const response = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GEMINI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: userInput }]
            }
          ]
        }),
      }
    );

    // 先把回傳原始文字 parse 一下
    const data = await response.json();
    console.log("Gemini 回傳：", data);

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ 沒有回覆內容";
    res.json({ reply });

  } catch (err) {
    console.error("伺服器錯誤：", err);
    res.status(500).json({ reply: "伺服器錯誤" });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
