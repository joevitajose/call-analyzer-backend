import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import multer from "multer";

dotenv.config();

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function auth(req, res, next) {
  const expected = `Bearer ${process.env.ACTION_SECRET}`;
  const got = req.headers.authorization;
  if (!got || got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/transcribe", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file. Upload an audio file." });
    }

    // Convert buffer to a File-like object for OpenAI SDK
    const file = new File([req.file.buffer], req.file.originalname || "call.mp3", {
      type: req.file.mimetype || "audio/mpeg",
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    const text = transcription.text || "";

    return res.json({
      call_id: crypto.randomUUID(),
      duration_sec: 0,
      segments: text
        ? [{ start: 0, end: 0, speaker: "Unknown", text }]
        : [],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Transcription failed",
      details: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));