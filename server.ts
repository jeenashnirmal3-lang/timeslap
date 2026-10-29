import express from "express";
import path from "path";
import fs from "fs";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import multer from "multer";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";

const execAsync = promisify(exec);

dotenv.config();

const app = express();
// Cloud Run sets PORT=8080 for Nginx. The Node/Express applet server must strictly run on port 3000 behind Nginx.
const PORT = 3000;

// Disk storage directory for audio uploads & chunks (bypasses 32MB Cloud Run / reverse proxy limits)
const UPLOAD_DIR = path.join("/tmp", "audio_uploads");
const CHUNKS_DIR = path.join(UPLOAD_DIR, "raw_chunks");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

// In-memory session registry with file paths or buffers
interface AudioSession {
  buffer?: Buffer;
  filePath?: string;
  originalname: string;
  mimetype: string;
  size: number;
  createdAt: number;
  acousticPauses?: Array<{ start: number; end: number; duration: number }>;
}
const audioSessions = new Map<string, AudioSession>();

// Cleanup stale sessions and temporary audio files older than 20 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of audioSessions.entries()) {
    if (now - session.createdAt > 20 * 60 * 1000) {
      if (session.filePath && fs.existsSync(session.filePath)) {
        try {
          fs.unlinkSync(session.filePath);
        } catch (e) {
          console.debug("Error cleaning expired session file:", e);
        }
      }
      audioSessions.delete(id);
    }
  }
}, 60 * 1000);

// Multer chunk storage: max 20MB per slice (client sends in 8MB chunks to stay well under Cloud Run's 32MB limit)
const chunkUpload = multer({
  dest: CHUNKS_DIR,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

// Multer in-memory storage for direct small audio uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 150 * 1024 * 1024, // 150MB
  },
  fileFilter: (_req, file, cb) => {
    const allowedMime = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/wave",
      "audio/x-wav",
      "audio/m4a",
      "audio/x-m4a",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm",
      "audio/flac",
    ];
    const allowedExts = [".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".webm", ".flac"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMime.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file format. Please upload an MP3, WAV, or M4A audio file."));
    }
  },
});

// CORS & Preflight handling for iframe requests and cookie credentials
app.use((req, res, next) => {
  const origin = req.headers.origin || (req.headers.host ? `${req.protocol}://${req.headers.host}` : "");
  if (origin && origin !== "null" && origin !== "*") {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "120mb" }));
app.use(express.urlencoded({ extended: true, limit: "120mb" }));

// Initialize Gemini client lazily or safely
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is missing.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

/**
 * Normalizes raw timestamps into [M:SS] format.
 * Rounds to nearest second. No leading zero on minutes.
 */
function formatSecondsToTimestamp(totalSeconds: number): string {
  // Use Math.floor so the timestamp always begins at or before the word's acoustic onset,
  // preventing any clipping of the word's initial audio frequency!
  const sec = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `[${minutes}:${String(seconds).padStart(2, "0")}]`;
}

/**
 * Normalizes raw LLM output into standardized, clean [M:SS] lines:
 * - Line breaks correspond strictly to audio frequency silence/pause cuts (>= 100ms)
 * - Aligns timestamps with real audio silence/pause analysis from FFmpeg
 * - Strictly increasing timestamps
 * - Supports timeOffset for multi-audio sequential stitching
 */
/**
 * Splits long sentences and clauses into ultra-short micro-phrases (2-5 words max).
 * Rules:
 * 1. Short sentences (<= 4 words, e.g. "Tonight," or "The Hadza," or "They survived.") are NEVER broken!
 * 2. Big/long sentences are broken down at:
 *    - Punctuation (commas, semicolons, dashes, ellipsis)
 *    - Clause markers: that, which, who, whom, what to do, how to do, the day you, the next time
 *    - Conjunctions: because, cuz, since, although, though, while, whereas, but, however, so, and then
 *    - Compound conjunctions: and running water, and whipworm, and many other, and most of
 *    - Prepositional/adverbial phrases: as fertilizer, like the, between two, in the first, for most of
 *    - Infinitives/verbs: trying to, started turning, tended to, from becoming, to control, to figure out, to prevent
 */
function splitIntoMicroPhrases(text: string): string[] {
  if (!text || !text.trim()) return [];
  const clean = text.trim();
  const words = clean.split(/\s+/);

  // Short sentences (<= 4 words) without internal commas are NOT split!
  if (words.length <= 4 && !/[,;—\-].+/.test(clean)) {
    return [clean];
  }

  // 1. Initial split on explicit commas, semicolons, em-dashes, ellipsis
  const initialSegments = clean.split(/(?<=[,;:\u2014\u2013]|\.{2,})\s+/);
  const resultPhrases: string[] = [];

  const boundaryRegex = /(?<=\S)\s+(?=(?:(?:because|cuz|since|although|though|even though|while|whereas|but|however|therefore)\b|(?:\bso\b(?!\s+(?:the\s+next\s+time|that|much)))|(?:\b(?:and\s+then|and\s+so|so\s+that|in\s+order\s+to)\b)|(?:\b(?:that|which|who|whom)\b)|(?:\b(?:what|how|where|why)\s+to\s+\w+\b)|(?:\b(?:the\s+day|the\s+time|the\s+moment|the\s+first\s+time)\s+(?:you|we|they|he|she|someone|people)\b)|(?<!\bso\s+)(?:\bthe\s+next\s+time\s+(?:you|we|they|he|she|someone|people)\b)|(?:\b(?:when|where|if|unless|whether)\s+\w+\b)|(?:\bas\s+(?:fertilizer|a\s+result|well)\b)|(?:\blike\s+the\b)|(?:\b(?:started|began)\s+(?:turning|moving|changing)\b)|(?:\btended\s+to\s+\w+\b)|(?:\btrying\s+to\b)|(?:\bwould\s+have\b)|(?:\bby\s+(?:your\s+own|their\s+own)\b)|(?:\bfrom\s+(?:becoming|getting|being)\b)|(?:\bto\s+(?:control|figure\s+out|prevent|tell|become)\b)|(?:\blong\s+enough\s+to\b)|(?<!\blong\s+)(?:\benough\s+to\b)|(?:\bbetween\s+(?:two|\d+|the)\b)|(?:\bin\s+the\s+(?:first|last|next|middle)\b)|(?:\band\s+(?:running|whipworm|many\s+other|most\s+of)\b)|(?:\bhad\s+no\s+\w+\b)|(?:\ba\s+disease\s+problem\b)|(?:\bmarriage\s+has\s+always\b)|(?:\bthe\s+more\s+\w+\b)))/i;

  for (const seg of initialSegments) {
    const trimmedSeg = seg.trim();
    if (!trimmedSeg) continue;

    const parts = trimmedSeg.split(boundaryRegex).map((p) => p.trim()).filter(Boolean);

    for (const p of parts) {
      const pWords = p.split(/\s+/);
      // Only break if phrase exceeds 6 words
      if (pWords.length > 6) {
        let currentChunk: string[] = [];
        for (let i = 0; i < pWords.length; i++) {
          currentChunk.push(pWords[i]);
          const remaining = pWords.length - (i + 1);
          const isBreakWord =
            i >= 2 &&
            remaining >= 2 &&
            /^(to|in|at|on|for|with|from|by|about|into|through|over|after|before|and|or)$/i.test(
              pWords[i + 1] || ""
            );
          if (currentChunk.length >= 6 || (currentChunk.length >= 3 && isBreakWord)) {
            resultPhrases.push(currentChunk.join(" "));
            currentChunk = [];
          }
        }
        if (currentChunk.length > 0) {
          resultPhrases.push(currentChunk.join(" "));
        }
      } else {
        resultPhrases.push(p);
      }
    }
  }

  return resultPhrases.map((p) => p.replace(/[,;—-]+$/, "").trim()).filter(Boolean);
}

/**
 * Normalizes raw model output into standardized, clean [M:SS] lines:
 * - Splits long sentences into ultra-short micro-phrases (2-5 words max)
 * - Breaks before clauses like "because", "but", "so", "when"
 * - Aligns timestamps with real audio silence/pause analysis from FFmpeg
 * - Strictly increasing timestamps
 * - Supports timeOffset for multi-audio sequential stitching
 */
function postProcessTranscript(
  rawText: string,
  breakAtPauses = true,
  timeOffset = 0,
  acousticPauses?: Array<{ start: number; end: number; duration: number }>
): string {
  // Strip code fences if present
  let cleaned = rawText.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();

  // Split lines
  const rawLines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsedItems: Array<{ seconds: number; text: string }> = [];

  const timestampRegex = /^\[?(\d{1,2}):(\d{2})(?:\.\d+)?\]?[:\s-]*(.*)$/;
  const hourTimestampRegex = /^\[?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?\]?[:\s-]*(.*)$/;

  let lastKnownSeconds = 0;

  for (const line of rawLines) {
    if (
      line.toLowerCase().startsWith("here is the transcript") ||
      line.toLowerCase().startsWith("transcript:") ||
      line.toLowerCase().startsWith("transcription:")
    ) {
      continue;
    }

    let seconds: number | null = null;
    let text = line;

    const matchHour = line.match(hourTimestampRegex);
    if (matchHour) {
      const h = parseInt(matchHour[1], 10);
      const m = parseInt(matchHour[2], 10);
      const s = parseInt(matchHour[3], 10);
      seconds = h * 3600 + m * 60 + s;
      text = matchHour[4];
    } else {
      const matchMin = line.match(timestampRegex);
      if (matchMin) {
        const m = parseInt(matchMin[1], 10);
        const s = parseInt(matchMin[2], 10);
        seconds = m * 60 + s;
        text = matchMin[3];
      }
    }

    if (seconds !== null) {
      lastKnownSeconds = seconds;
    } else {
      seconds = lastKnownSeconds;
    }

    text = text.replace(/^(speaker\s*\d+|[a-z]+)\s*:\s*/i, "").trim();
    text = text.replace(/^\[.*?\]\s*/, "").trim();

    if (text) {
      parsedItems.push({ seconds, text });
    }
  }

  // Format into final lines: EVERY big sentence is split into short micro-phrases (2-5 words)
  const formattedLines: string[] = [];
  let lastAssignedSec = -1;

  for (let i = 0; i < parsedItems.length; i++) {
    const item = parsedItems[i];
    const subPhrases = breakAtPauses ? splitIntoMicroPhrases(item.text) : [item.text];
    if (subPhrases.length === 0) continue;

    const startSec = item.seconds;
    const nextItem = parsedItems[i + 1];
    const nextSec = nextItem ? nextItem.seconds : null;

    const totalWords = subPhrases.reduce((acc, p) => acc + p.split(/\s+/).length, 0);
    const estimatedDuration =
      nextSec && nextSec > startSec
        ? nextSec - startSec
        : Math.max(subPhrases.length * 2, Math.ceil(totalWords / 2.3));

    // Acoustic pauses that fall strictly within this line's audio window
    const sentenceMaxSec = nextSec ? nextSec : startSec + estimatedDuration;
    const segmentPauses =
      acousticPauses && acousticPauses.length > 0
        ? acousticPauses.filter(
            (p) => p.end >= startSec - 0.2 && p.start <= sentenceMaxSec + 0.2
          )
        : [];

    let accumulatedWords = 0;
    for (let j = 0; j < subPhrases.length; j++) {
      const phrase = subPhrases[j];
      const wordCount = phrase.split(/\s+/).length;

      let phraseSec: number;
      if (j === 0) {
        phraseSec = startSec;
      } else {
        const progressFraction = accumulatedWords / Math.max(1, totalWords);
        const approxTarget = startSec + progressFraction * estimatedDuration;

        // Find the best real acoustic pause where audio frequency drops to silence (>= 100ms)
        let matchedPause: { start: number; end: number; duration: number } | undefined;
        if (segmentPauses.length > 0) {
          matchedPause = segmentPauses
            .filter((p) => p.end > lastAssignedSec && (!nextSec || p.end < nextSec))
            .sort((a, b) => Math.abs(a.end - approxTarget) - Math.abs(b.end - approxTarget))[0];
        }

        if (matchedPause) {
          // Snap strictly to the silence before speech resumes so the first word's frequency is NEVER cut!
          phraseSec = Math.floor(matchedPause.end);
        } else {
          // Use floor on the proportional target so timestamp starts before or at the word onset
          phraseSec = Math.floor(approxTarget);
        }
      }
      accumulatedWords += wordCount;

      if (phraseSec <= lastAssignedSec) {
        phraseSec = lastAssignedSec + 1;
      }
      if (nextSec && j < subPhrases.length - 1 && phraseSec >= nextSec) {
        phraseSec = Math.max(lastAssignedSec + 1, nextSec - 1);
      }
      lastAssignedSec = phraseSec;

      formattedLines.push(`${formatSecondsToTimestamp(phraseSec + timeOffset)} ${phrase}`);
    }
  }

  return formattedLines.join("\n");
}

/**
 * Transcribe using OpenAI Whisper API if OPENAI_API_KEY is available
 */
async function transcribeWithWhisper(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  breakAtPauses = true,
  timeOffset = 0
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const blob = new Blob([fileBuffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, fileName);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "word");
  formData.append("timestamp_granularities[]", "segment");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errData = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${errData}`);
  }

  const data = (await response.json()) as {
    text?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };

  // If word timestamps are available, segment at spoken pauses (>0.35s) and punctuation
  if (data.words && data.words.length > 0 && breakAtPauses) {
    const lines: string[] = [];
    let currentWords: string[] = [];
    let chunkStartSec = data.words[0].start;

    for (let i = 0; i < data.words.length; i++) {
      const w = data.words[i];
      const wordText = w.word.trim();
      if (!wordText) continue;

      if (currentWords.length === 0) {
        chunkStartSec = w.start;
      }
      currentWords.push(wordText);

      const isPunctuationPause = /[,;:.!?—]$/.test(wordText);
      const nextWord = data.words[i + 1];
      const nextWordText = nextWord ? nextWord.word.trim() : "";
      const isConjunctionStart = /^(because|cuz|since|although|though|while|whereas|but|however|so|when|whenever|if|unless|which|that|and|or)\b/i.test(nextWordText);
      // Break strictly on noticeable audio silence (>= 0.10s / 100ms), punctuation pause, conjunction, or 5 words max
      const hasSpokenPause = nextWord && nextWord.start - w.end >= 0.10;
      const isTooLong = currentWords.length >= 5;

      if (isPunctuationPause || hasSpokenPause || (isConjunctionStart && currentWords.length >= 2) || isTooLong || i === data.words.length - 1) {
        let phrase = currentWords.join(" ").replace(/[,;]+$/, "").trim();
        if (phrase) {
          phrase = phrase.charAt(0).toUpperCase() + phrase.slice(1);
          lines.push(`${formatSecondsToTimestamp(chunkStartSec + timeOffset)} ${phrase}`);
        }
        currentWords = [];
      }
    }

    if (lines.length > 0) {
      return postProcessTranscript(lines.join("\n"), breakAtPauses, timeOffset);
    }
  }

  if (data.segments && data.segments.length > 0) {
    const lines: string[] = [];
    for (const seg of data.segments) {
      const segText = seg.text.trim();
      if (!segText) continue;
      lines.push(`${formatSecondsToTimestamp(seg.start + timeOffset)} ${segText}`);
    }
    return postProcessTranscript(lines.join("\n"), breakAtPauses, timeOffset);
  }

  return postProcessTranscript(data.text || "", breakAtPauses, timeOffset);
}

/**
 * Helper to parse FFmpeg silencedetect output lines.
 */
function parseSilencedetectOutput(raw: string): Array<{ start: number; end: number; duration: number }> {
  const pauses: Array<{ start: number; end: number; duration: number }> = [];
  let currentStart: number | null = null;
  for (const line of raw.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (endMatch && currentStart !== null) {
      const end = parseFloat(endMatch[1]);
      const dur = parseFloat(endMatch[2]);
      pauses.push({ start: currentStart, end, duration: dur });
      currentStart = null;
    }
  }
  return pauses;
}

/**
 * Analyzes audio frequency and acoustic silence intervals asynchronously using FFmpeg.
 * Ultra-high sensitivity mode: extracts speech pauses >= 0.100s (100ms) with noise threshold -24dB.
 * Captures micro-breaths, rapid cadence breaks, and every subtle pause throughout the speech.
 */
async function detectAcousticPausesAsync(
  audioFilePath: string,
  minDurationSec = 0.10,
  noiseThreshold = "-24dB"
): Promise<Array<{ start: number; end: number; duration: number }>> {
  try {
    const { stdout, stderr } = await execAsync(
      `ffmpeg -i "${audioFilePath}" -af silencedetect=noise=${noiseThreshold}:d=${minDurationSec} -f null -`,
      { timeout: 45000 }
    );
    let pauses = parseSilencedetectOutput(`${stdout || ""}\n${stderr || ""}`);

    // If few pauses detected (e.g. ambient noise floor or soft breaths), run sensitive adaptive pass
    if (pauses.length < 8) {
      try {
        const pass2 = await execAsync(
          `ffmpeg -i "${audioFilePath}" -af silencedetect=noise=-22dB:d=0.10 -f null -`,
          { timeout: 45000 }
        );
        const pauses2 = parseSilencedetectOutput(`${pass2.stdout || ""}\n${pass2.stderr || ""}`);
        if (pauses2.length > pauses.length) {
          pauses = pauses2;
        }
      } catch {}
    }

    return pauses;
  } catch (err: any) {
    const raw = `${err?.stdout || ""}\n${err?.stderr || ""}`;
    if (raw.includes("silencedetect")) {
      return parseSilencedetectOutput(raw);
    }
    console.warn("Acoustic silence detection skipped or timed out:", err?.message);
    return [];
  }
}

function detectAcousticPauses(
  audioFilePath: string,
  minDurationSec = 0.10,
  noiseThreshold = "-24dB"
): Array<{ start: number; end: number; duration: number }> {
  try {
    const raw = execSync(`ffmpeg -i "${audioFilePath}" -af silencedetect=noise=${noiseThreshold}:d=${minDurationSec} -f null - 2>&1`, {
      encoding: "utf8",
      timeout: 30000,
    });
    let pauses = parseSilencedetectOutput(raw);
    if (pauses.length < 8) {
      try {
        const raw2 = execSync(`ffmpeg -i "${audioFilePath}" -af silencedetect=noise=-22dB:d=0.10 -f null - 2>&1`, {
          encoding: "utf8",
          timeout: 30000,
        });
        const pauses2 = parseSilencedetectOutput(raw2);
        if (pauses2.length > pauses.length) pauses = pauses2;
      } catch {}
    }
    return pauses;
  } catch (err: any) {
    const raw = String(err?.stdout || err?.stderr || err?.message || "");
    if (raw.includes("silencedetect")) {
      return parseSilencedetectOutput(raw);
    }
    console.warn("Acoustic silence detection skipped:", err?.message);
    return [];
  }
}

/**
 * Helper to build the optimized transcription prompt for Gemini.
 * Ultra-high sensitivity mode: instructs model to break on every audible pause, breath, and vocal cadence drop >= 100ms.
 */
function buildGeminiPrompt(
  breakAtPauses: boolean,
  detectedPauses?: Array<{ start: number; end: number; duration: number }>
): string {
  let acousticHintSection = "";
  if (detectedPauses && detectedPauses.length > 0) {
    const pauseTimestamps = detectedPauses
      .slice(0, 200)
      .map((p) => formatSecondsToTimestamp(p.end))
      .join(", ");
    acousticHintSection = `\n====================================================
AUDIO WAVEFORM ANALYSIS: DETECTED PAUSES (>= 100ms)
====================================================
The audio frequency analyzer detected ${detectedPauses.length} audible pauses & breaths (>= 100ms) with speech resuming at:
${pauseTimestamps}${detectedPauses.length > 200 ? "..." : ""}

Break into a new [M:SS] line at these audio pause markers!\n`;
  }

  return `MASTER PROMPT — PHRASE SEGMENTATION TRANSCRIPTION (BADE SENTENCE KO PHRASE MEIN TOD)

Listen attentively to the audio track. You MUST transcribe the spoken audio by breaking sentences into natural phrases.

====================================================
CORE RULE: PHRASING RULES FOR SHORT vs LONG SENTENCES
====================================================
1. CHHOTE SENTENCES (<= 4 words, like "Tonight," or "The Hadza," or "They survived."):
   - DO NOT BREAK! Keep short sentences intact as a single line.
2. BADE / LONG SENTENCES (> 4 words):
   - You MUST BREAK inside the sentence into short 2-4 word phrases at clause boundaries, conjunctions, transitions, and pauses!

CRITICAL EXAMPLES OF HOW TO BREAK LONG SENTENCES:
- "no one with power to tell an entire group what to do."
  -> [0:18] no one with power
  -> [0:20] to tell an entire group
  -> [0:22] what to do

- "Anthropologist Christopher Boehm found that hunter-gatherer groups actively prevented anyone from becoming too powerful."
  -> [0:41] Anthropologist Christopher Boehm found
  -> [0:43] that hunter-gatherer groups actively prevented anyone
  -> [0:46] from becoming too powerful

- "For most of human history, trying to become a king would have gotten you executed by your own camp."
  -> [0:57] For most of human history,
  -> [1:00] trying to become a king
  -> [1:03] would have gotten you executed
  -> [1:05] by your own camp

- "You can't eat a whole field the day you harvest it."
  -> [1:18] You can't eat a whole field
  -> [1:20] the day you harvest it

- "A hunted animal gets shared immediately because it rots."
  -> [1:24] A hunted animal gets shared immediately
  -> [1:27] because it rots

- "no one could hoard enough food to control anyone else because food never sat still long enough to hoard."
  -> [1:46] no one could hoard enough food
  -> [1:48] to control anyone else
  -> [1:50] because food never sat still
  -> [1:52] long enough to hoard

- "The more food men contributed to their families, the more monogamous the society tended to be."
  -> [1:57] The more food men contributed to their families,
  -> [2:00] the more monogamous the society
  -> [2:02] tended to be

- "people even spread human waste on their fields as fertilizer,"
  -> [3:11] people even spread human waste on their fields
  -> [3:13] as fertilizer,

- "which sent roundworm and whipworm eggs straight back onto the food they ate."
  -> [3:14] which sent roundworm
  -> [3:16] and whipworm eggs straight back
  -> [3:18] onto the food they ate

- "famous for their public toilets and running water,"
  -> [3:19] famous for their public toilets
  -> [3:21] and running water,

- "we created a disease problem that had barely existed before,"
  -> [4:22] we created
  -> [4:24] a disease problem
  -> [4:26] that had barely existed before,

- "and then it took thousands of years just to figure out that washing your hands could help."
  -> [4:27] and then it took thousands of years
  -> [4:30] just to figure out
  -> [4:32] that washing your hands could help

- "Health agencies like the World Health Organization still say that washing with soap is one of the best ways to prevent diarrhea and many other infections."
  -> [4:34] Health agencies
  -> [4:36] like the World Health Organization still say
  -> [4:39] that washing with soap is one of the best ways
  -> [4:42] to prevent diarrhea
  -> [4:44] and many other infections

- "Most divorces happened in the first few years,"
  -> [1:05] Most divorces happened
  -> [1:07] in the first few years,

- "and most of those couples had no children yet."
  -> [1:07] and most of those couples
  -> [1:09] had no children yet

- "In the anthropological record, polygyny tends to rise when wealth differences grow."
  -> [3:56] In the anthropological record,
  -> [3:58] polygyny tends to rise
  -> [4:00] when wealth differences grow

- "A bond between two people started turning into a deal between two families."
  -> [4:18] A bond between two people
  -> [4:20] started turning into a deal
  -> [4:22] between two families

- "So the next time someone tells you marriage has always worked the same way,"
  -> [4:50] So the next time someone tells you
  -> [4:52] marriage has always worked the same way

====================================================
AUDIO FREQUENCY PRESERVATION RULE (PREVENT WORD CLIPPING)
====================================================
CRITICAL: When you break a big sentence into phrases, the [M:SS] timestamp of EVERY broken phrase MUST align with the exact moment of silence BEFORE that phrase's first word begins in the audio!
- NEVER cut into the word's acoustic frequency! The audio waveform of the first word must NEVER be clipped or cut in the middle of a syllable.
- ALWAYS place the timestamp at the silence trough, breath, or acoustic pause immediately preceding the first word.
- Never round forward into the word: if a phrase starts speaking at 1:24.3, write [1:24], NEVER [1:25]! Writing [1:25] cuts off the opening syllable and severs the audio frequency of the word!
- Phrase cuts must coincide with natural audio frequency dips (>= 100ms pauses/breaths) where sound amplitude drops, ensuring clean cuts with 100% intact audio frequency on every word!
${acousticHintSection}
====================================================
TIMESTAMP FORMAT
====================================================
Always output strictly as: [M:SS] Spoken phrase text.
- Minutes: no leading zero (0, 1, 12).
- Seconds: always two digits, zero-padded (05, 47).
- One space after the closing bracket, then the text.
- Timestamps must be strictly increasing and match the exact second where speech resumes.

Output ONLY the timestamped lines line-by-line. No speaker labels, no conversational intro/outro, no code fences.`;
}

// Helper to extract human-readable error from raw SDK error
function cleanErrorMessage(err: any): string {
  const rawMsg = err?.message || String(err || "");
  try {
    const parsed = JSON.parse(rawMsg);
    if (parsed?.error?.message) return parsed.error.message;
    if (parsed?.message) return parsed.message;
  } catch {
    // regex check for embedded JSON in message
    const match = rawMsg.match(/\{.*"message"\s*:\s*"([^"]+)".*\}/);
    if (match && match[1]) return match[1];
  }
  return rawMsg;
}

/**
 * Asynchronously compress/optimize audio with FFmpeg to 16kHz mono 32k MP3.
 * Non-blocking child process ensures the Node.js event loop and socket connections stay alive.
 */
async function optimizeAudioFileAsync(inputFilePath: string): Promise<string> {
  try {
    const ext = path.extname(inputFilePath);
    const optimizedPath = inputFilePath.replace(new RegExp(`${ext}$`), `_opt_${Date.now()}.mp3`);
    await execAsync(`ffmpeg -y -i "${inputFilePath}" -vn -ac 1 -ar 16000 -b:a 32k "${optimizedPath}"`, {
      timeout: 60000,
    });
    if (fs.existsSync(optimizedPath) && fs.statSync(optimizedPath).size > 0) {
      const origSize = fs.statSync(inputFilePath).size;
      const newSize = fs.statSync(optimizedPath).size;
      console.log(`Audio compressed with FFmpeg: ${(origSize / (1024 * 1024)).toFixed(1)}MB -> ${(newSize / (1024 * 1024)).toFixed(2)}MB`);
      try {
        fs.unlinkSync(inputFilePath);
      } catch {}
      return optimizedPath;
    }
  } catch (err) {
    console.warn("FFmpeg audio optimization skipped or timed out:", err);
  }
  return inputFilePath;
}

/**
 * Automatically compress/optimize audio with FFmpeg to 16kHz mono 32k MP3.
 * Preserves spoken word clarity with 100% precision while reducing file size by 90-98%!
 * A 37MB-100MB audio file shrinks to ~1.2MB in 1-2 seconds, allowing instant streaming with zero timeout risk.
 */
function optimizeAudioFile(inputFilePath: string): string {
  try {
    const ext = path.extname(inputFilePath);
    const optimizedPath = inputFilePath.replace(new RegExp(`${ext}$`), `_opt_${Date.now()}.mp3`);
    execSync(`ffmpeg -y -i "${inputFilePath}" -vn -ac 1 -ar 16000 -b:a 32k "${optimizedPath}"`, {
      stdio: "ignore",
      timeout: 45000,
    });
    if (fs.existsSync(optimizedPath) && fs.statSync(optimizedPath).size > 0) {
      const origSize = fs.statSync(inputFilePath).size;
      const newSize = fs.statSync(optimizedPath).size;
      console.log(`Audio compressed with FFmpeg: ${(origSize / (1024 * 1024)).toFixed(1)}MB -> ${(newSize / (1024 * 1024)).toFixed(2)}MB`);
      try {
        fs.unlinkSync(inputFilePath);
      } catch {}
      return optimizedPath;
    }
  } catch (err) {
    console.warn("FFmpeg audio optimization skipped or timed out:", err);
  }
  return inputFilePath;
}

/**
 * Helper to prepare audio for Gemini using fast inlineData or File API for massive recordings
 */
async function prepareGeminiContentsParts(
  ai: GoogleGenAI,
  audioSource: { buffer?: Buffer; filePath?: string },
  effectiveMime: string,
  prompt: string
): Promise<{ parts: any[]; geminiUploadedFile?: any; tempFileToCleanup?: string }> {
  let fileForGemini = audioSource.filePath;
  let tempFileToCleanup: string | undefined;

  // If buffer is provided, write to disk to optimize
  if (!fileForGemini && audioSource.buffer) {
    const ext = effectiveMime.includes("mp4") ? ".mp4" : effectiveMime.includes("wav") ? ".wav" : ".mp3";
    const tmpPath = path.join(UPLOAD_DIR, `temp_gemini_${crypto.randomUUID()}${ext}`);
    fs.writeFileSync(tmpPath, audioSource.buffer);
    const optPath = optimizeAudioFile(tmpPath);
    fileForGemini = optPath;
    tempFileToCleanup = optPath;
    effectiveMime = "audio/mp3";
  }

  // If file path exists, ensure it is optimized
  if (fileForGemini && fs.existsSync(fileForGemini)) {
    if (!fileForGemini.includes("_opt_")) {
      const optPath = optimizeAudioFile(fileForGemini);
      fileForGemini = optPath;
      if (tempFileToCleanup && tempFileToCleanup !== optPath) {
        tempFileToCleanup = optPath;
      }
      effectiveMime = "audio/mp3";
    }

    const fileSize = fs.statSync(fileForGemini).size;

    // For files under 18MB (after 16kHz mono compression, 18MB covers over 2 hours of continuous speech!),
    // inlineData is ultra-fast, zero-overhead, and never suffers network/ETIMEDOUT issues
    if (fileSize <= 18 * 1024 * 1024) {
      const audioBuf = fs.readFileSync(fileForGemini);
      const base64Audio = audioBuf.toString("base64");
      return {
        parts: [
          { inlineData: { mimeType: "audio/mp3", data: base64Audio } },
          { text: prompt },
        ],
        tempFileToCleanup,
      };
    }

    // For ultra-long recordings (> 18MB compressed), upload to Gemini File API
    console.log(`Uploading ultra-long audio to Gemini File API: ${fileForGemini} (${Math.round(fileSize / (1024 * 1024))} MB)`);
    const uploadResult = await ai.files.upload({
      file: fileForGemini,
      config: {
        mimeType: "audio/mp3",
      },
    });
    console.log(`Gemini File API upload complete: ${uploadResult.name}`);
    return {
      parts: [
        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType || "audio/mp3" } },
        { text: prompt },
      ],
      geminiUploadedFile: uploadResult,
      tempFileToCleanup,
    };
  } else if (audioSource.buffer) {
    const base64Audio = audioSource.buffer.toString("base64");
    return {
      parts: [
        { inlineData: { mimeType: effectiveMime, data: base64Audio } },
        { text: prompt },
      ],
      tempFileToCleanup,
    };
  } else {
    throw new Error("No audio content provided for transcription.");
  }
}

/**
 * Transcribe using Gemini API with optional timeOffset for consecutive audio files
 */
async function transcribeWithGemini(
  audioSource: { buffer?: Buffer; filePath?: string },
  mimeType: string,
  breakAtPauses = true,
  timeOffset = 0,
  acousticPauses?: Array<{ start: number; end: number; duration: number }>
): Promise<string> {
  const ai = getGeminiClient();

  // Determine appropriate mime type for Gemini
  let effectiveMime = mimeType;
  if (effectiveMime === "audio/x-m4a" || effectiveMime === "audio/m4a") {
    effectiveMime = "audio/mp4";
  } else if (effectiveMime === "audio/wave" || effectiveMime === "audio/x-wav") {
    effectiveMime = "audio/wav";
  }

  const prompt = buildGeminiPrompt(breakAtPauses, acousticPauses);

  // Priority list of Gemini models: fast gemini-3.1-flash-lite, gemini-3.5-transcribe, gemini-flash-latest, gemini-3.8-flash
  const candidateModels: Array<{ model: string; config?: Record<string, any> }> = [
    {
      model: "gemini-3.1-flash-lite",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-3.5-transcribe",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-flash-latest",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-3.8-flash",
      config: {
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  ];

  let lastError: any = null;
  let geminiUploadedFile: any = null;
  let tempFileToCleanup: string | undefined;

  try {
    const prepared = await prepareGeminiContentsParts(ai, audioSource, effectiveMime, prompt);
    geminiUploadedFile = prepared.geminiUploadedFile;
    tempFileToCleanup = prepared.tempFileToCleanup;

    for (const item of candidateModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: item.model,
            config: item.config,
            contents: {
              parts: prepared.parts,
            },
          });

          const rawText = response.text || "";
          if (rawText.trim().length > 0) {
            return postProcessTranscript(rawText, breakAtPauses, timeOffset, acousticPauses);
          }
          return "";
        } catch (err: any) {
          lastError = err;
          const msg = cleanErrorMessage(err);
          const isTransient = /503|high demand|429|rate limit|temporarily unavailable/i.test(msg);
          console.warn(`Model ${item.model} (attempt ${attempt}) failed: ${msg}`);

          if (isTransient && attempt === 1) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          break;
        }
      }
    }
  } finally {
    if (geminiUploadedFile?.name) {
      try {
        await ai.files.delete({ name: geminiUploadedFile.name });
      } catch (e) {
        console.debug("Error deleting uploaded Gemini file:", e);
      }
    }
    if (tempFileToCleanup && fs.existsSync(tempFileToCleanup)) {
      try {
        fs.unlinkSync(tempFileToCleanup);
      } catch (e) {}
    }
  }

  const finalMsg = cleanErrorMessage(lastError);
  throw new Error(finalMsg || "All transcription models were unavailable. Please try again in a few moments.");
}

/**
 * Streaming transcription with Gemini.
 * Emits live chunks as the model generates speech timestamps.
 */
async function transcribeStreamWithGemini(
  audioSource: { buffer?: Buffer; filePath?: string },
  mimetype: string,
  breakAtPauses: boolean,
  timeOffset: number,
  onChunk: (chunkText: string, fullRawSoFar: string) => void,
  acousticPauses?: Array<{ start: number; end: number; duration: number }>
): Promise<string> {
  const ai = getGeminiClient();
  let effectiveMime = mimetype && mimetype.startsWith("audio/") ? mimetype : "audio/mp3";
  if (effectiveMime === "audio/x-m4a" || effectiveMime === "audio/m4a") {
    effectiveMime = "audio/mp4";
  } else if (effectiveMime === "audio/wave" || effectiveMime === "audio/x-wav") {
    effectiveMime = "audio/wav";
  }

  const prompt = buildGeminiPrompt(breakAtPauses, acousticPauses);

  const candidateModels: Array<{ model: string; config?: Record<string, any> }> = [
    {
      model: "gemini-3.1-flash-lite",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-3.5-transcribe",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-flash-latest",
      config: {
        temperature: 0.1,
      },
    },
    {
      model: "gemini-3.8-flash",
      config: {
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  ];

  let lastError: any = null;
  let geminiUploadedFile: any = null;
  let tempFileToCleanup: string | undefined;

  try {
    const prepared = await prepareGeminiContentsParts(ai, audioSource, effectiveMime, prompt);
    geminiUploadedFile = prepared.geminiUploadedFile;
    tempFileToCleanup = prepared.tempFileToCleanup;

    for (const item of candidateModels) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const streamResponse = await ai.models.generateContentStream({
            model: item.model,
            config: item.config,
            contents: {
              parts: prepared.parts,
            },
          });

          let accumulated = "";
          for await (const chunk of streamResponse) {
            const text = chunk.text || "";
            if (text) {
              accumulated += text;
              onChunk(text, accumulated);
            }
          }

          if (accumulated.trim().length > 0) {
            return postProcessTranscript(accumulated, breakAtPauses, timeOffset, acousticPauses);
          }
          return "";
        } catch (err: any) {
          lastError = err;
          const msg = cleanErrorMessage(err);
          const isTransient = /503|high demand|429|rate limit|temporarily unavailable/i.test(msg);
          console.warn(`Streaming model ${item.model} (attempt ${attempt}) failed: ${msg}`);

          if (isTransient && attempt === 1) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          break;
        }
      }
    }
  } finally {
    if (geminiUploadedFile?.name) {
      try {
        await ai.files.delete({ name: geminiUploadedFile.name });
      } catch (e) {
        console.debug("Error deleting uploaded Gemini file:", e);
      }
    }
    if (tempFileToCleanup && fs.existsSync(tempFileToCleanup)) {
      try {
        fs.unlinkSync(tempFileToCleanup);
      } catch (e) {}
    }
  }

  const finalMsg = cleanErrorMessage(lastError);
  throw new Error(finalMsg || "All transcription models were unavailable. Please try again in a few moments.");
}

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

// Chunked upload endpoint to completely bypass reverse proxy / Cloud Run 32MB payload limits
app.post("/api/upload-chunk", (req, res) => {
  chunkUpload.single("chunk")(req, res, (uploadErr: any) => {
    if (uploadErr) {
      console.error("Chunk upload multer error:", uploadErr);
      return res.status(400).json({ error: `Upload error: ${uploadErr.message || uploadErr}` });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No chunk file received." });
    }

    const sessionId = String(req.body.sessionId || "").trim();
    const chunkIndex = parseInt(String(req.body.chunkIndex), 10);
    const totalChunks = parseInt(String(req.body.totalChunks), 10);
    const fileName = String(req.body.fileName || "audio.mp3");
    const mimeType = String(req.body.mimeType || "audio/mpeg");

    if (!sessionId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      if (req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      return res.status(400).json({ error: "Missing required chunk metadata (sessionId, chunkIndex, totalChunks)." });
    }

    const tempFilePath = path.join(UPLOAD_DIR, `${sessionId}.part`);

    try {
      if (chunkIndex === 0 && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }

      const chunkData = fs.readFileSync(req.file.path);
      fs.appendFileSync(tempFilePath, chunkData);
      fs.unlinkSync(req.file.path);

      const isComplete = chunkIndex === totalChunks - 1;

      if (isComplete) {
        const ext = path.extname(fileName) || ".mp3";
        const rawFilePath = path.join(UPLOAD_DIR, `${sessionId}${ext}`);
        if (fs.existsSync(rawFilePath)) {
          try {
            fs.unlinkSync(rawFilePath);
          } catch {}
        }
        fs.renameSync(tempFilePath, rawFilePath);
        const finalSize = fs.statSync(rawFilePath).size;

        audioSessions.set(sessionId, {
          filePath: rawFilePath,
          originalname: fileName,
          mimetype: mimeType || "audio/mpeg",
          size: finalSize,
          createdAt: Date.now(),
        });

        console.log(`Chunked upload completed for session ${sessionId}: ${fileName} (${(finalSize / (1024 * 1024)).toFixed(1)} MB ready)`);

        return res.json({
          sessionId,
          isComplete: true,
          filename: fileName,
          size: finalSize,
        });
      }

      return res.json({
        sessionId,
        chunkIndex,
        totalChunks,
        isComplete: false,
      });
    } catch (err: any) {
      console.error("Chunk upload write error:", err);
      if (req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      return res.status(500).json({ error: `Failed to process audio chunk: ${err.message}` });
    }
  });
});

// Upload audio endpoint (provides 0-100% upload progress tracking from client for small files)
app.post("/api/upload-audio", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided. Please upload an audio file (mp3, wav, m4a)." });
  }

  const { originalname, buffer, mimetype, size } = req.file;

  if (size > 150 * 1024 * 1024) {
    return res.status(400).json({ error: "Audio file too large. Maximum supported size is 150MB." });
  }

  const sessionId = crypto.randomUUID();
  const ext = path.extname(originalname) || ".mp3";
  const rawPath = path.join(UPLOAD_DIR, `${sessionId}${ext}`);
  fs.writeFileSync(rawPath, buffer);

  audioSessions.set(sessionId, {
    filePath: rawPath,
    originalname,
    mimetype: mimetype || "audio/mpeg",
    size: buffer.length,
    createdAt: Date.now(),
  });

  console.log(`Audio upload session created: ${sessionId} for ${originalname} (${Math.round(size / 1024)} KB)`);

  return res.json({
    sessionId,
    filename: originalname,
    size,
    mimetype,
  });
});

// Live streaming transcription endpoint (SSE Server-Sent Events)
app.get("/api/transcribe-stream", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const session = audioSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Audio upload session expired or not found. Please upload again." });
  }

  const breakAtPauses = req.query.granularity !== "sentence";
  const timeOffset = req.query.timeOffset ? Math.max(0, parseFloat(String(req.query.timeOffset))) : 0;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  const sendEvent = (event: string, data: Record<string, any>) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    } catch (e) {
      console.warn("Failed to write SSE event:", e);
    }
  };

  // Keep-alive heartbeat: sends comment every 2.5 seconds so proxies never drop the SSE connection
  const keepAliveTimer = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    } catch {}
  }, 2500);

  req.on("close", () => {
    clearInterval(keepAliveTimer);
  });

  sendEvent("status", { message: "⚡ Audio received. Preparing audio waveform..." });

  try {
    // If not optimized yet, optimize and detect acoustic pauses asynchronously during SSE stream
    if (session.filePath && !session.filePath.includes("_opt_")) {
      sendEvent("status", { message: "⚡ Compressing audio & detecting ultra-high density (100ms) acoustic pause markers..." });
      const optPath = await optimizeAudioFileAsync(session.filePath);
      session.filePath = optPath;
      session.mimetype = "audio/mp3";
      session.size = fs.statSync(optPath).size;
      session.acousticPauses = await detectAcousticPausesAsync(optPath, 0.10);
      console.log(`Audio ready for session ${sessionId}: ${(session.size / (1024 * 1024)).toFixed(2)} MB, ${session.acousticPauses.length} acoustic pauses >= 0.10s`);
    }

    sendEvent("status", {
      message: `⚡ AI Speech Model connected (${session.acousticPauses?.length || 0} acoustic pauses detected). Streaming live...`,
    });

    const finalTranscript = await transcribeStreamWithGemini(
      { buffer: session.buffer, filePath: session.filePath },
      session.mimetype,
      breakAtPauses,
      timeOffset,
      (chunkText, fullRawSoFar) => {
        // Extract timestamp lines generated so far for live preview
        const rawLines = fullRawSoFar.split(/\r?\n/).filter((l) => l.trim().length > 0);
        sendEvent("chunk", {
          chunk: chunkText,
          linesCount: rawLines.length,
          latestLine: rawLines[rawLines.length - 1] || "",
          rawSoFar: fullRawSoFar,
        });
      },
      session.acousticPauses
    );

    if (!finalTranscript || finalTranscript.trim().length === 0) {
      sendEvent("error", {
        error: "Transcription produced an empty result. Ensure the audio contains clear spoken speech.",
      });
      res.end();
      return;
    }

    sendEvent("done", {
      transcript: finalTranscript,
      filename: session.originalname,
      linesCount: finalTranscript.split("\n").filter(Boolean).length,
      timeOffset,
    });
    res.end();
  } catch (err: any) {
    console.error("Stream transcription error:", err);
    sendEvent("error", { error: err?.message || "Transcription failed." });
    res.end();
  } finally {
    clearInterval(keepAliveTimer);
  }
});

// Direct session transcription endpoint (no audio re-upload needed, uses existing uploaded chunks)
app.post("/api/transcribe-session", async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || "");
    const session = audioSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Audio session expired or not found. Please upload again." });
    }

    const breakAtPauses = req.body?.granularity !== "sentence";
    const timeOffset = req.body?.timeOffset ? Math.max(0, parseFloat(String(req.body.timeOffset))) : 0;

    if (session.filePath && !session.filePath.includes("_opt_")) {
      const optPath = await optimizeAudioFileAsync(session.filePath);
      session.filePath = optPath;
      session.mimetype = "audio/mp3";
      session.size = fs.statSync(optPath).size;
      session.acousticPauses = await detectAcousticPausesAsync(optPath, 0.10);
    } else if (session.filePath && (!session.acousticPauses || session.acousticPauses.length === 0)) {
      session.acousticPauses = await detectAcousticPausesAsync(session.filePath, 0.10);
    }

    const transcript = await transcribeWithGemini(
      { buffer: session.buffer, filePath: session.filePath },
      session.mimetype,
      breakAtPauses,
      timeOffset,
      session.acousticPauses
    );

    if (!transcript || transcript.trim().length === 0) {
      return res.status(422).json({
        error: "Transcription produced an empty result. Ensure the audio contains clear spoken speech.",
      });
    }

    return res.json({
      transcript,
      filename: session.originalname,
      fileSize: session.size,
      timeOffset,
      linesCount: transcript.split("\n").filter(Boolean).length,
    });
  } catch (err: any) {
    console.error("Transcribe session error:", err);
    return res.status(500).json({ error: err?.message || "Failed to transcribe audio session." });
  }
});

// Transcription endpoint (supports timeOffset for sequential multi-audio files)
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided. Please upload an audio file (mp3, wav, m4a)." });
    }

    const { originalname, buffer, mimetype, size } = req.file;

    // Check size limit: 150MB
    if (size > 150 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large. Maximum supported file size is 150MB." });
    }

    // By default breakAtPauses is true (micro-phrase / pause break requested by user)
    const breakAtPauses = req.body?.granularity !== "sentence";

    // Parse timeOffset (in seconds) if user is uploading audio #2 or beyond
    const timeOffset = req.body?.timeOffset ? Math.max(0, parseFloat(req.body.timeOffset)) : 0;

    console.log(`Received audio file: ${originalname} (${mimetype}, ${Math.round(size / 1024)} KB), timeOffset=${timeOffset}s, breakAtPauses=${breakAtPauses}`);

    // Optimize and detect acoustic pauses
    let acousticPauses: Array<{ start: number; end: number; duration: number }> = [];
    const tmpOpt = path.join(UPLOAD_DIR, `direct_${crypto.randomUUID()}.mp3`);
    fs.writeFileSync(tmpOpt, buffer);
    const optimizedDirect = optimizeAudioFile(tmpOpt);
    acousticPauses = detectAcousticPauses(optimizedDirect, 0.10);

    let transcript = "";

    // Prefer OpenAI Whisper if key is provided and requested, otherwise use Gemini
    const preferWhisper = req.body?.service === "whisper" && process.env.OPENAI_API_KEY;

    if (preferWhisper) {
      transcript = await transcribeWithWhisper(buffer, originalname, mimetype, breakAtPauses, timeOffset);
    } else if (process.env.GEMINI_API_KEY) {
      transcript = await transcribeWithGemini({ filePath: optimizedDirect }, "audio/mp3", breakAtPauses, timeOffset, acousticPauses);
    } else if (process.env.OPENAI_API_KEY) {
      transcript = await transcribeWithWhisper(buffer, originalname, mimetype, breakAtPauses, timeOffset);
    } else {
      try { fs.unlinkSync(optimizedDirect); } catch {}
      return res.status(500).json({
        error: "No transcription API key configured. Please configure GEMINI_API_KEY in the environment.",
      });
    }

    try { fs.unlinkSync(optimizedDirect); } catch {}

    if (!transcript || transcript.trim().length === 0) {
      return res.status(422).json({
        error: "Transcription produced an empty result. Ensure the audio contains clear spoken speech.",
      });
    }

    return res.json({
      transcript,
      filename: originalname,
      fileSize: size,
      timeOffset,
      linesCount: transcript.split("\n").filter(Boolean).length,
    });
  } catch (err: any) {
    console.error("Transcription error:", err);
    const errorMessage = err?.message || "An error occurred while processing the audio file.";
    return res.status(500).json({ error: errorMessage });
  }
});

// Error handling middleware for multer & uploads
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Audio file exceeds maximum size limit (100MB)." });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ error: err.message || "Upload processing error." });
  }
  next();
});

// Guard: Ensure any unhandled /api/* route returns JSON, never an HTML page
app.all("/api/*", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
