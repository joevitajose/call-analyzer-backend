import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" })); // body is small; audio is fetched by URL

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Auth middleware for GPT Actions ---
function auth(req, res, next) {
  const expected = `Bearer ${process.env.ACTION_SECRET}`;
  const got = req.headers.authorization;

  if (!got || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Basic request logging (helps debugging in Render logs) ---
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// --- Health route (Render + quick check) ---
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- Transcribe route ---
app.post("/transcribe", auth, async (req, res) => {
  try {
    // Log body keys so you can see what Actions are sending
    console.log("BODY KEYS:", Object.keys(req.body || {}));

    const refs = req.body?.openaiFileIdRefs;

    if (!Array.isArray(refs) || refs.length === 0) {
      return res.status(400).json({
        error: "Missing openaiFileIdRefs. Upload an audio file in ChatGPT and try again.",
      });
    }

    const first = refs[0] || {};
    console.log("FIRST REF:", first);

    // Actions usually give a signed URL to download
    const fileUrl = first.url || first.download_url || first.downloadUrl;
    if (!fileUrl) {
      return res.status(400).json({
        error: "No url/download_url found in openaiFileIdRefs[0].",
        received: first,
      });
    }

    // Download audio bytes
    const audioResp = await fetch(fileUrl);
    if (!audioResp.ok) {
      const details = await audioResp.text().catch(() => "");
      return res.status(400).json({
        error: `Failed to download audio (${audioResp.status} ${audioResp.statusText})`,
        details: details.slice(0, 300),
      });
    }

    const buffer = Buffer.from(await audioResp.arrayBuffer());

    // Convert to a file-like object OpenAI accepts (works reliably on Node)
    // openai.toFile is available in OpenAI JS SDK and avoids File global issues
    const audioFile = await OpenAI.toFile(buffer, "call.mp3");

    // Transcribe
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });

    const text = transcription?.text || "";

    // Return in the exact shape your GPT expects
    return res.json({
      call_id: crypto.randomUUID(),
      duration_sec: 0,
      segments: text
        ? [
            {
              start: 0,
              end: 0,
              speaker: "Unknown",
              text,
            },
          ]
        : [],
    });
  } catch (err) {
    console.error("TRANSCRIBE ERROR:", err);
    return res.status(500).json({
      error: "Transcription failed",
      details: err?.message || String(err),
    });
  }
});

// Render uses PORT env var
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});