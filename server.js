import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

dotenv.config();

const app = express();
app.use(cors());

// Increase if you expect long recordings
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
    });
  });
}

async function transcribeFile(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
  });
  return transcription?.text || "";
}

app.post("/transcribe", auth, upload.single("file"), async (req, res) => {
  const call_id = crypto.randomUUID();

  const tmpDir = os.tmpdir();
  let inputPath = null;
  let normalizedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file. Upload an audio file." });
    }

    // Detect actual file container from bytes (more reliable than mimetype)
    const detected = await fileTypeFromBuffer(req.file.buffer);
    const ext = (
      detected?.ext ||
      req.file.originalname?.split(".").pop() ||
      "bin"
    ).toLowerCase();

    // Save original upload to a temp file
    inputPath = path.join(tmpDir, `call-${call_id}.${ext}`);
    fs.writeFileSync(inputPath, req.file.buffer);

    // 1) Try direct transcription first (fast path)
    try {
      const text = await transcribeFile(inputPath);

      return res.json({
        call_id,
        duration_sec: 0,
        segments: text ? [{ start: 0, end: 0, speaker: "Unknown", text }] : [],
        meta: {
          mode: "direct",
          detected,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
        },
      });
    } catch (directError) {
      // 2) Fallback: normalize via ffmpeg to WAV (16k mono), then transcribe
      normalizedPath = path.join(tmpDir, `call-${call_id}.wav`);

      const ffmpegArgs = [
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1",       // mono
        "-ar",
        "16000",   // 16kHz
        "-vn",     // strip video track if any
        normalizedPath,
      ];

      if (!ffmpegPath) {
        throw new Error(
          "ffmpeg-static did not provide a binary path. Check Render architecture or ffmpeg-static install."
        );
      }

      await run(ffmpegPath, ffmpegArgs);

      const text = await transcribeFile(normalizedPath);

      return res.json({
        call_id,
        duration_sec: 0,
        segments: text ? [{ start: 0, end: 0, speaker: "Unknown", text }] : [],
        meta: {
          mode: "ffmpeg-fallback",
          detected,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          direct_error: directError?.message || String(directError),
        },
      });
    }
  } catch (err) {
    console.error("Transcription failed:", err);
    return res.status(500).json({
      error: "Transcription failed",
      details: err?.message || String(err),
    });
  } finally {
    // Cleanup temp files
    try {
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch {}
    try {
      if (normalizedPath && fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
    } catch {}
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));