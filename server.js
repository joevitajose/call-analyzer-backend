import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function auth(req, res, next) {
  const expected = `Bearer ${process.env.ACTION_SECRET}`;
  const got = req.headers.authorization;
  if (!got || got !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/transcribe", auth, async (req, res) => {
  try {
    const refs = req.body?.openaiFileIdRefs;
    if (!Array.isArray(refs) || refs.length === 0) {
      return res.status(400).json({ error: "Missing openaiFileIdRefs (upload audio in ChatGPT)" });
    }

    const fileRef = refs[0];
    const fileUrl = fileRef.url || fileRef.download_url;
    if (!fileUrl) return res.status(400).json({ error: "No file URL found in openaiFileIdRefs[0]" });

    const audioResp = await fetch(fileUrl);
    if (!audioResp.ok) {
      return res.status(400).json({ error: `Failed to download audio: ${audioResp.status}` });
    }

    const buffer = Buffer.from(await audioResp.arrayBuffer());

    // Node 18+ supports File
    const file = new File([buffer], "call.mp3", { type: "audio/mpeg" });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    const text = transcription.text || "";
    return res.json({
      call_id: crypto.randomUUID(),
      duration_sec: 0,
      segments: text ? [{ start: 0, end: 0, speaker: "Unknown", text }] : [],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Transcription failed", details: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));