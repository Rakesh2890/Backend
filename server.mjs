import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.FREEPIK_API_KEY; // store your key in .env

// Route to start image generation
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    // Step 1: Start the AI generation
    const startResp = await fetch("https://api.freepik.com/v1/ai/mystic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-freepik-api-key": API_KEY,
      },
      body: JSON.stringify({
        prompt,
        resolution: "2k",
        model: "realism",
      }),
    });

    const startData = await startResp.json();

    if (!startData.data || !startData.data.task_id) {
      return res.status(500).json({ error: "Failed to start generation" });
    }

    const taskId = startData.data.task_id;
    let status = "IN_PROGRESS";
    let generatedImages = [];
    let attempts = 0;
    const maxAttempts = 10; // stop after ~150 sec

    // Step 2: Poll every 15 seconds until completion
    while (status === "IN_PROGRESS" && attempts < maxAttempts) {
      attempts++;
      console.log(`Checking status... attempt ${attempts}`);

      await new Promise((r) => setTimeout(r, 15000)); // 15 sec wait

      const checkResp = await fetch(
        `https://api.freepik.com/v1/ai/mystic/${taskId}`,
        { headers: { "x-freepik-api-key": API_KEY } }
      );
      const checkData = await checkResp.json();

      if (checkData.data) {
        status = checkData.data.status;
        generatedImages = checkData.data.generated || [];
        console.log("Current status:", status, "Images:", generatedImages.length);
      }
    }

    if (generatedImages.length > 0) {
      res.json({ images: generatedImages });
    } else {
      res.json({ images: [], message: "No image was generated. Try a more descriptive prompt." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate image" });
  }
});

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
