const express = require("express");
const bodyParser = require("body-parser");
//const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(express.json());
// app.use(bodyParser.json());

// 提供前端靜態檔案
app.use(express.static(path.join(__dirname, "public")));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/gpt", async (req, res) => {
  const userText = req.body.text;
  console.log("收到練習內容：", userText);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // 或 "gpt-3.5-turbo"
        messages: [
          { role: "system", content: "你是一位在MI教導鼓Technique的老師，幫使用者把練習內容整理成鼓勵語句" },
          { role: "user", content: userText }
        ]
      })
    });

    const data = await response.json();
    console.log("GPT 回覆：", data.choices[0].message.content);
    console.log("GPT 原始回傳：", JSON.stringify(data, null, 2));

    if (!data.choices) {
    return res.status(500).json({
      reply: "⚠️ GPT API 沒有回傳 choices，錯誤訊息：" + (data.error?.message || "未知錯誤")
    });
    }

    const reply = data.choices[0].message.content;
    // res.json({ reply });

    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "伺服器或 GPT API 發生錯誤" });
  }
  /*
  console.log("收到請求：", req.body);
  try {
    // 模板生成（不用 API，先測試流程）
    const userText = req.body.text;
    const reply = `你今天練習了：${userText}，加油！`;
    console.log("回覆：", reply);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "伺服器錯誤" });
  }
  */
  /*
  const userText = req.body.text;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "你是一位鼓教練，幫使用者把練習內容整理成鼓勵語句" },
        { role: "user", content: userText }
      ]
    })
  });

  const data = await response.json();
  res.json({ reply: data.choices[0].message.content });
  */
});

/* 本地端測試
app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
*/

// Heroku
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
app.get("/ping", (req, res) => {
  res.send("pong");
});

