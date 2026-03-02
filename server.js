// server.js (DISK upload + "accept anything" transcription with ffmpeg fallback)
// Works better on Render for large files because it avoids multer.memoryStorage() RAM spikes.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { fileTypeFromBuffer } from "file-type";

dotenv.config();

const app = express();
app.use(cors());

// Optional: nicer root response (prevents "Cannot GET /")
app.get("/", (_req, res) => {
  res.send("Call Analyzer backend is running. Use GET /health or POST /transcribe");
});

app.get("/health", (_req, res) => res.json({ ok: true }));

function auth(req, res, next) {
  const expected = `Bearer ${process.env.ACTION_SECRET}`;
  const got = req.headers.authorization;
  if (!got || got !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ---- Multer: DISK storage (critical for big files on Render) ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const safe = (file.originalname || "upload").replace(/[^\w.-]/g, "_");
      cb(null, `${crypto.randomUUID()}-${safe}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

// ---- Helpers ----
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

// Read only the first chunk for type detection (memory-safe)
function readHead(filePath, bytes = 64 * 1024) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

async function transcribeFile(openai, filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
  });
  return transcription?.text || "";
}

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Route ----
app.post("/transcribe", auth, upload.single("file"), async (req, res) => {
  const call_id = crypto.randomUUID();
  let inputPath = null;
  let normalizedPath = null;

  try {
    if (!req.file?.path) {
      return res.status(400).json({ error: "Missing file. Upload an audio file." });
    }

    if (!ffmpegPath) {
      return res.status(500).json({
        error: "Server misconfigured",
        details: "ffmpeg-static did not provide a binary path.",
      });
    }

    inputPath = req.file.path;

    // Detect container/type from file header (not from mimetype)
    const head = readHead(inputPath);
    const detected = await fileTypeFromBuffer(head);

    // 1) Try direct transcription first
    try {
      const text = await transcribeFile(openai, inputPath);

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
      // 2) Fallback: normalize to WAV 16k mono, then transcribe
      normalizedPath = path.join(os.tmpdir(), `call-${call_id}.wav`);

      const ffmpegArgs = [
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1", // mono
        "-ar",
        "16000", // 16kHz
        "-vn", // strip video if present
        normalizedPath,
      ];

      await run(ffmpegPath, ffmpegArgs);

      const text = await transcribeFile(openai, normalizedPath);

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
    // Cleanup uploaded file from disk
    try {
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch {}

    // Cleanup normalized file
    try {
      if (normalizedPath && fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
    } catch {}
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));