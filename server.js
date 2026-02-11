import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import { File } from "node:buffer";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const expected = `Bearer ${process.env.ACTION_SECRET}`;
  if (authHeader !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/transcribe", auth, async (req, res) => {
  try {
    const fileRef = req.body?.openaiFileIdRefs?.[0];

    // ChatGPT Actions sends a temporary download URL for the uploaded audio file
    const fileUrl =
      fileRef?.url ||
      fileRef?.download_url ||
      fileRef?.file_url ||
      fileRef?.href;

    if (!fileUrl) {
      return res.status(400).json({
        error: "No audio file URL found in openaiFileIdRefs[0].",
        hint: "Make sure your Action requestBody uses openaiFileIdRefs.",
      });
    }

    // Download audio immediately (URL expires quickly)
    const audioResponse = await fetch(fileUrl);
    if (!audioResponse.ok) {
      return res.status(400).json({ error: `Failed to download audio: ${audioResponse.status}` });
    }

    const buffer = Buffer.from(await audioResponse.arrayBuffer());

    // Transcribe with diarization
    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], "call.wav"),
      model: "gpt-4o-transcribe-diarize",
      chunking: "auto",
      response_format: "diarized_json",
    });

    const segments = (transcription.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      speaker: s.speaker,
      text: s.text,
    }));

    res.json({
      call_id: crypto.randomUUID(),
      duration_sec: transcription.duration ?? null,
      segments,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
