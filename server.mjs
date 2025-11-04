// server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(express.json());

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));

const API_KEY = process.env.FREEPIK_API_KEY;
if (!API_KEY) console.warn("FREEPIK_API_KEY not set");

const PORT = Number(process.env.PORT) || 3000;

// in-memory task store
// taskId -> { status: "IN_PROGRESS"|"COMPLETED"|"FAILED", images: [...], message, createdAt }
const tasks = new Map();

function genTaskId() {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

// background poller for a single task
async function pollFreepikTask(taskId, freepikTaskId, pollIntervalMs = 15000, maxAttempts = 20) {
  let attempts = 0;
  try {
    while (attempts < maxAttempts) {
      attempts++;
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const checkResp = await fetch(`https://api.freepik.com/v1/ai/mystic/${freepikTaskId}`, {
        headers: { "x-freepik-api-key": API_KEY }
      });

      let checkData;
      try {
        checkData = await checkResp.json();
      } catch (e) {
        console.warn(`Failed to parse Freepik status JSON:`, e);
        continue;
      }

      console.log(`Task poll ${taskId} attempt ${attempts} status:`, checkData?.data?.status);

      const status = checkData?.data?.status;
      const generated = checkData?.data?.generated ?? [];

      if (status === "COMPLETED" && generated.length > 0) {
        tasks.set(taskId, { status: "COMPLETED", images: generated, message: "Completed", createdAt: Date.now() });
        return;
      } else if (status === "FAILED") {
        tasks.set(taskId, { status: "FAILED", images: [], message: checkData?.error?.message || "Generation failed", createdAt: Date.now() });
        return;
      } else {
        // still in progress -> update record (optional)
        tasks.set(taskId, { status: "IN_PROGRESS", images: [], message: "In progress", createdAt: Date.now() });
      }
    }

    // max attempts reached
    tasks.set(taskId, { status: "FAILED", images: [], message: "Timeout polling provider", createdAt: Date.now() });
  } catch (err) {
    console.error("pollFreepikTask error:", err);
    tasks.set(taskId, { status: "FAILED", images: [], message: "Server error while polling", createdAt: Date.now() });
  }
}

// POST /generate-image -> start job, return taskId immediately
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    // call Freepik to create a job
    const startResp = await fetch("https://api.freepik.com/v1/ai/mystic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-freepik-api-key": API_KEY
      },
      body: JSON.stringify({
        prompt,
        // reduce resolution to speed up as needed:
        resolution: process.env.DEFAULT_RESOLUTION || "1k",
        model: process.env.DEFAULT_MODEL || "realism"
      })
    });

    if (!startResp.ok) {
      const txt = await startResp.text().catch(() => null);
      console.error("Start generation failed:", startResp.status, txt);
      return res.status(502).json({ error: "Failed to start generation", details: txt });
    }

    const startData = await startResp.json();
    const freepikTaskId = startData?.data?.task_id;
    if (!freepikTaskId) {
      console.error("No task_id in start response:", startData);
      return res.status(500).json({ error: "Failed to start generation" });
    }

    // generate our own task id, store initial state, and start background polling
    const taskId = genTaskId();
    tasks.set(taskId, { status: "IN_PROGRESS", images: [], message: "Started", createdAt: Date.now() });

    // background (do not await)
    (async () => {
      // poll interval and attempts can be configured via env
      const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS) || 15000;
      const maxAttempts = Number(process.env.MAX_POLL_ATTEMPTS) || 20;
      await pollFreepikTask(taskId, freepikTaskId, pollIntervalMs, maxAttempts);
    })();

    // return to client immediately
    return res.status(202).json({ task_id: taskId, status: "IN_PROGRESS", message: "Task accepted" });
  } catch (err) {
    console.error("generate-image POST error:", err);
    return res.status(500).json({ error: "Server error starting generation" });
  }
});

// GET /status/:taskId -> return current state and images if available
app.get("/status/:taskId", (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ error: "Missing taskId" });

    const task = tasks.get(taskId);
    if (!task) return res.status(404).json({ status: "NOT_FOUND", message: "Task not found" });

    return res.json({ status: task.status, images: task.images || [], message: task.message });
  } catch (err) {
    console.error("status endpoint error:", err);
    return res.status(500).json({ error: "Server error retrieving status" });
  }
});

// optional: cleanup old tasks (every hour)
setInterval(() => {
  const TTL = Number(process.env.TASK_TTL_MS) || 1000 * 60 * 60; // 1 hour
  const now = Date.now();
  for (const [k, v] of tasks.entries()) {
    if (v.createdAt && now - v.createdAt > TTL) tasks.delete(k);
  }
}, 1000 * 60 * 10); // run every 10 minutes

app.get("/", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
