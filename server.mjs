// server.mjs

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*"
  })
);

const API_KEY = process.env.PIXAZO_API_KEY;
const PORT = Number(process.env.PORT) || 3000;

const GENERATE_URL =
  "https://gateway.pixazo.ai/gpt-image-2-5-flare/v1/text-to-image";

const STATUS_URL =
  "https://gateway.pixazo.ai/v2/requests/status/";

const tasks = new Map();

function genTaskId() {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { message: text || "Empty API response" };
  }
}

async function pollPixazoTask(taskId, requestId) {
  const maxAttempts = Number(process.env.MAX_POLL_ATTEMPTS) || 60;
  const interval = Number(process.env.POLL_INTERVAL_MS) || 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    try {
      const response = await fetch(
        STATUS_URL + encodeURIComponent(requestId),
        {
          headers: {
            "Ocp-Apim-Subscription-Key": API_KEY,
            "Cache-Control": "no-cache"
          }
        }
      );

      const data = await readJson(response);

      if (!response.ok) {
        console.error("Pixazo status error:", response.status, data);

        if ([401, 403, 404].includes(response.status)) {
          tasks.set(taskId, {
            status: "FAILED",
            images: [],
            message: "Unable to retrieve Pixazo task status",
            createdAt: Date.now()
          });
          return;
        }

        continue;
      }

      const status = String(data.status || "").toUpperCase();

      console.log(`Task ${taskId}: ${status}`);

      if (status === "COMPLETED") {
        const media = data.output?.media_url;
        const images = Array.isArray(media)
          ? media
          : typeof media === "string"
            ? [media]
            : [];

        if (!images.length) {
          tasks.set(taskId, {
            status: "FAILED",
            images: [],
            message: "Pixazo completed without returning an image URL",
            createdAt: Date.now()
          });
          return;
        }

        tasks.set(taskId, {
          status: "COMPLETED",
          images,
          message: "Image generated successfully",
          createdAt: Date.now()
        });
        return;
      }

      if (["FAILED", "ERROR"].includes(status)) {
        tasks.set(taskId, {
          status: "FAILED",
          images: [],
          message:
            typeof data.error === "string"
              ? data.error
              : data.error?.message || "Pixazo generation failed",
          createdAt: Date.now()
        });
        return;
      }

      tasks.set(taskId, {
        status: "IN_PROGRESS",
        images: [],
        message: "Image generation in progress",
        createdAt: Date.now()
      });
    } catch (error) {
      console.error("Pixazo polling error:", error.message);
    }
  }

  tasks.set(taskId, {
    status: "FAILED",
    images: [],
    message: "Generation timed out. Please try again.",
    createdAt: Date.now()
  });
}

app.post("/generate-image", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "PIXAZO_API_KEY is missing in server environment variables"
      });
    }

    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";

    if (!prompt) {
      return res.status(400).json({
        error: "Prompt is required"
      });
    }

    const response = await fetch(GENERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": API_KEY
      },
      body: JSON.stringify({ prompt })
    });

    const data = await readJson(response);

    if (!response.ok) {
      console.error(
        "Pixazo generation error:",
        response.status,
        data
      );

      return res.status(502).json({
        error: "Failed to start generation",
        details:
          data.message ||
          data.error ||
          `Pixazo returned HTTP ${response.status}`
      });
    }

    const requestId = data.request_id;

    if (!requestId) {
      console.error("Pixazo response missing request_id:", data);

      return res.status(502).json({
        error: "Pixazo did not return a request ID"
      });
    }

    const taskId = genTaskId();

    tasks.set(taskId, {
      status: "IN_PROGRESS",
      images: [],
      message: "Generation started",
      createdAt: Date.now()
    });

    // Poll in the background without delaying the initial response.
    pollPixazoTask(taskId, requestId).catch((error) => {
      console.error("Background task error:", error.message);

      tasks.set(taskId, {
        status: "FAILED",
        images: [],
        message: "Server error while checking generation status",
        createdAt: Date.now()
      });
    });

    return res.status(202).json({
      task_id: taskId,
      status: "IN_PROGRESS",
      message: "Image generation started"
    });
  } catch (error) {
    console.error("Generate image error:", error.message);

    return res.status(500).json({
      error: "Server error starting generation"
    });
  }
});

app.get("/status/:taskId", (req, res) => {
  const task = tasks.get(req.params.taskId);

  if (!task) {
    return res.status(404).json({
      status: "NOT_FOUND",
      message: "Task not found"
    });
  }

  return res.json({
    status: task.status,
    images: task.images,
    message: task.message
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    provider: "Pixazo"
  });
});

// Clean up old task records.
setInterval(() => {
  const ttl = Number(process.env.TASK_TTL_MS) || 3600000;
  const now = Date.now();

  for (const [id, task] of tasks.entries()) {
    if (now - task.createdAt > ttl) {
      tasks.delete(id);
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Pixazo image server listening on port ${PORT}`);
});
