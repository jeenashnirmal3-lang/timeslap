import React, { useState, useRef, useEffect } from "react";
import {
  FileAudio,
  Sparkles,
  Loader2,
  AlertCircle,
  Clock,
  ArrowRight,
  FileText,
  Volume2,
  Info,
  Layers,
  Plus,
  UploadCloud,
  Zap,
  Radio,
  CheckCircle2,
} from "lucide-react";
import { AudioDropzone } from "./components/AudioDropzone";
import { AudioPlayer, AudioPlayerHandle } from "./components/AudioPlayer";
import { TranscriptEditor } from "./components/TranscriptEditor";
import { AudioFileInfo, ProcessingStep, UploadProgress } from "./types";

export default function App() {
  const [files, setFiles] = useState<AudioFileInfo[]>([]);
  const [status, setStatus] = useState<ProcessingStep>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [granularity, setGranularity] = useState<"micro" | "sentence">("micro");
  const [activePartIndex, setActivePartIndex] = useState<number>(0);

  // Upload progress tracking (0% to 100%, MBs, transfer speed)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  // Live streaming lines & timestamp preview
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [liveLatestLine, setLiveLatestLine] = useState<string>("");

  const audioPlayerRef = useRef<AudioPlayerHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const liveTerminalRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll live streaming preview
  useEffect(() => {
    if (liveTerminalRef.current) {
      liveTerminalRef.current.scrollTop = liveTerminalRef.current.scrollHeight;
    }
  }, [liveLines, liveLatestLine]);

  // On mount: Warm up backend connection & configure security cookie for AI Studio iframe
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.location.hostname) {
        document.cookie = `__SECURE-aistudio_auth_flow_may_set_cookies=true; Path=/; Secure; SameSite=None; Domain=${window.location.hostname}; Partitioned; Max-Age=3600;`;
      }
    } catch (e) {
      console.debug("Auth cookie setup:", e);
    }

    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.debug("Backend ready:", data))
      .catch((err) => console.debug("Health check warmup:", err));
  }, []);

  // Timer for loading state
  useEffect(() => {
    if (status === "uploading" || status === "transcribing" || status === "formatting") {
      setElapsedSeconds(0);
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  const handleFilesAdd = (newFiles: AudioFileInfo[]) => {
    setFiles((prev) => [...prev, ...newFiles]);
    setErrorMessage(null);
  };

  const handleFileRemove = (index: number) => {
    setFiles((prev) => {
      const removed = prev[index];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleFileMove = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= files.length) return;
    setFiles((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return copy;
    });
  };

  const handleFilesClear = () => {
    files.forEach((f) => {
      if (f.url) URL.revokeObjectURL(f.url);
    });
    setFiles([]);
    setErrorMessage(null);
  };

  const handleResetAll = () => {
    handleFilesClear();
    setTranscript("");
    setStatus("idle");
    setErrorMessage(null);
    setUploadProgress(null);
    setLiveLines([]);
    setLiveLatestLine("");
  };

  /**
   * Splits long sentences and clauses into ultra-short micro-phrases (2-5 words max).
   * Short sentences (<= 4 words, e.g. "Tonight," or "The Hadza,") are NEVER broken!
   * Used for real-time live preview rendering as speech chunks stream in.
   */
  const splitIntoMicroPhrasesClient = (text: string): string[] => {
    if (!text || !text.trim()) return [];
    const clean = text.trim();
    const words = clean.split(/\s+/);

    // Short sentences (<= 4 words) without internal commas are NOT split!
    if (words.length <= 4 && !/[,;—\-].+/.test(clean)) {
      return [clean];
    }

    const initialSegments = clean.split(/(?<=[,;:\u2014\u2013]|\.{2,})\s+/);
    const resultPhrases: string[] = [];

    const boundaryRegex = /(?<=\S)\s+(?=(?:(?:because|cuz|since|although|though|even though|while|whereas|but|however|therefore)\b|(?:\bso\b(?!\s+(?:the\s+next\s+time|that|much)))|(?:\b(?:and\s+then|and\s+so|so\s+that|in\s+order\s+to)\b)|(?:\b(?:that|which|who|whom)\b)|(?:\b(?:what|how|where|why)\s+to\s+\w+\b)|(?:\b(?:the\s+day|the\s+time|the\s+moment|the\s+first\s+time)\s+(?:you|we|they|he|she|someone|people)\b)|(?<!\bso\s+)(?:\bthe\s+next\s+time\s+(?:you|we|they|he|she|someone|people)\b)|(?:\b(?:when|where|if|unless|whether)\s+\w+\b)|(?:\bas\s+(?:fertilizer|a\s+result|well)\b)|(?:\blike\s+the\b)|(?:\b(?:started|began)\s+(?:turning|moving|changing)\b)|(?:\btended\s+to\s+\w+\b)|(?:\btrying\s+to\b)|(?:\bwould\s+have\b)|(?:\bby\s+(?:your\s+own|their\s+own)\b)|(?:\bfrom\s+(?:becoming|getting|being)\b)|(?:\bto\s+(?:control|figure\s+out|prevent|tell|become)\b)|(?:\blong\s+enough\s+to\b)|(?<!\blong\s+)(?:\benough\s+to\b)|(?:\bbetween\s+(?:two|\d+|the)\b)|(?:\bin\s+the\s+(?:first|last|next|middle)\b)|(?:\band\s+(?:running|whipworm|many\s+other|most\s+of)\b)|(?:\bhad\s+no\s+\w+\b)|(?:\ba\s+disease\s+problem\b)|(?:\bmarriage\s+has\s+always\b)|(?:\bthe\s+more\s+\w+\b)))/i;

    for (const seg of initialSegments) {
      const trimmedSeg = seg.trim();
      if (!trimmedSeg) continue;

      const parts = trimmedSeg.split(boundaryRegex).map((p) => p.trim()).filter(Boolean);

      for (const p of parts) {
        const pWords = p.split(/\s+/);
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
  };

  /**
   * Upload audio using reliable 8MB chunking to completely bypass reverse-proxy
   * and Cloud Run 32MB payload limits, providing smooth 0-100% upload progress.
   */
  const uploadAudioWithProgress = async (
    file: File,
    onProgress: (p: UploadProgress) => void
  ): Promise<{ sessionId: string; filename: string; size: number }> => {
    const CHUNK_SIZE = 3 * 1024 * 1024; // 3MB per chunk (safely under Cloud Run 32MB limit & smooth progress)
    const totalSize = file.size;
    const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const startTime = Date.now();

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalSize);
      const chunkBlob = file.slice(start, end);

      // Upload chunk with automatic retry (up to 5 attempts)
      let attempt = 0;
      let chunkSuccess = false;
      let lastChunkError: any = null;

      while (attempt < 5 && !chunkSuccess) {
        attempt++;
        try {
          const formData = new FormData();
          formData.append("chunk", chunkBlob, file.name);
          formData.append("sessionId", sessionId);
          formData.append("chunkIndex", String(chunkIndex));
          formData.append("totalChunks", String(totalChunks));
          formData.append("fileName", file.name);
          formData.append("fileSize", String(totalSize));
          formData.append("mimeType", file.type || "audio/mpeg");

          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const chunkBaseUploaded = start;

            xhr.upload.onprogress = (event) => {
              if (event.lengthComputable) {
                const currentChunkBytes = event.loaded;
                const grandTotalLoaded = Math.min(totalSize, chunkBaseUploaded + currentChunkBytes);
                const percent = Math.min(99, Math.round((grandTotalLoaded / totalSize) * 100));
                const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
                const bytesPerSec = grandTotalLoaded / elapsedSec;
                const mbPerSec = (bytesPerSec / (1024 * 1024)).toFixed(1);
                const speed = `${mbPerSec} MB/s`;

                onProgress({
                  loaded: grandTotalLoaded,
                  total: totalSize,
                  percent,
                  speed,
                });
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
              } else {
                let errMsg = `Upload failed with HTTP ${xhr.status}`;
                try {
                  const data = JSON.parse(xhr.responseText);
                  if (data?.error) errMsg = data.error;
                } catch {
                  if (xhr.responseText.includes("413") || xhr.responseText.toLowerCase().includes("too large")) {
                    errMsg = "Audio chunk exceeded upload limit. Please retry.";
                  }
                }
                reject(new Error(errMsg));
              }
            };

            xhr.onerror = async () => {
              // Seamless fallback to native fetch in case browser XHR policy blocked credentials
              try {
                const res = await fetch("/api/upload-chunk", {
                  method: "POST",
                  body: formData,
                });
                if (res.ok) {
                  resolve();
                  return;
                }
                const errData = await res.json().catch(() => null);
                reject(new Error(errData?.error || `Upload failed with HTTP ${res.status}`));
              } catch (fErr: any) {
                reject(new Error(`Connection interrupted on chunk ${chunkIndex + 1}/${totalChunks}.`));
              }
            };

            xhr.ontimeout = () => {
              reject(new Error(`Chunk ${chunkIndex + 1}/${totalChunks} upload timed out.`));
            };

            xhr.open("POST", "/api/upload-chunk");
            xhr.timeout = 90000;
            xhr.send(formData);
          });

          chunkSuccess = true;
        } catch (err: any) {
          lastChunkError = err;
          console.warn(`Chunk ${chunkIndex + 1}/${totalChunks} attempt ${attempt} failed:`, err);
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 600 * Math.pow(1.3, attempt)));
          }
        }
      }

      if (!chunkSuccess) {
        throw new Error(lastChunkError?.message || `Failed to upload audio chunk ${chunkIndex + 1}/${totalChunks}.`);
      }
    }

    onProgress({
      loaded: totalSize,
      total: totalSize,
      percent: 100,
      speed: "Upload complete",
    });

    return {
      sessionId,
      filename: file.name,
      size: totalSize,
    };
  };

  /**
   * Connect to Server-Sent Events (SSE) stream for live transcription and timestamp generation.
   */
  const streamTranscribe = (
    sessionId: string,
    timeOffset: number,
    onChunkReceived: (data: { chunk: string; linesCount: number; latestLine: string; rawSoFar: string }) => void,
    onStatusReceived: (msg: string) => void
  ): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      try {
        const query = new URLSearchParams({
          sessionId,
          granularity,
          timeOffset: String(timeOffset),
        });

        const fetchFn =
          typeof window !== "undefined" && (window as any)._nativeFetch
            ? (window as any)._nativeFetch
            : fetch;

        const res = await fetchFn(`/api/transcribe-stream?${query.toString()}`);

        if (!res.ok) {
          const errText = await res.text();
          let msg = `Transcription stream error (HTTP ${res.status})`;
          try {
            const parsed = JSON.parse(errText);
            if (parsed?.error) msg = parsed.error;
          } catch {}
          throw new Error(msg);
        }

        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error("Unable to establish live stream connection with server.");
        }

        const decoder = new TextDecoder("utf-8");
        let streamBuffer = "";
        let finalResult = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamBuffer += decoder.decode(value, { stream: true });
          const messages = streamBuffer.split("\n\n");
          streamBuffer = messages.pop() || ""; // Retain incomplete message chunk

          for (const msg of messages) {
            const trimmed = msg.trim();
            if (!trimmed || trimmed.startsWith(":")) continue; // Ignore SSE keepalives & empty lines

            let eventType = "message";
            let dataStr = "";

            const eventMatch = trimmed.match(/^event:\s*(\w+)/m);
            if (eventMatch) eventType = eventMatch[1];

            const dataMatch = trimmed.match(/^data:\s*(.+)$/m);
            if (dataMatch) dataStr = dataMatch[1];

            if (dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                if (eventType === "status") {
                  onStatusReceived(parsed.message || "");
                } else if (eventType === "chunk") {
                  onChunkReceived(parsed);
                } else if (eventType === "done") {
                  finalResult = parsed.transcript || "";
                } else if (eventType === "error") {
                  throw new Error(parsed.error || "Streaming transcription encountered an error.");
                }
              } catch (e: any) {
                if (eventType === "error" || e.message?.includes("transcription")) {
                  throw e;
                }
              }
            }
          }
        }

        if (finalResult && finalResult.trim().length > 0) {
          resolve(finalResult.trim());
        } else {
          // If done event was not caught explicitly but raw text was streamed, parse accumulated lines
          reject(new Error("Stream ended before receiving complete transcript. Please click Retry."));
        }
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   * Fallback direct transcription if streaming encounters a proxy, network, or socket disconnection.
   * Uses XMLHttpRequest to bypass any iframe fetch proxy serialization issues.
   * Prefers /api/transcribe-session to reuse already-uploaded chunks on server.
   */
  const fallbackDirectTranscribe = (
    file: File,
    timeOffset: number,
    sessionId?: string
  ): Promise<string> => {
    return new Promise((resolve, reject) => {
      const uploadDirectFile = () => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/transcribe");
        xhr.timeout = 180000;

        xhr.onload = () => {
          const contentType = xhr.getResponseHeader("content-type") || "";
          const isHtml = contentType.includes("text/html") || xhr.responseText.trim().startsWith("<");

          if (isHtml) {
            return reject(new Error("Server is warming up or reconnecting. Please wait a moment and click Retry Transcription."));
          }

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              if (data?.transcript) {
                return resolve(String(data.transcript).trim());
              }
              if (data?.error) {
                return reject(new Error(data.error));
              }
            } catch {
              return reject(new Error("Server returned an unreadable response. Please click Retry Transcription."));
            }
          }
          let err = `Transcription failed (HTTP ${xhr.status})`;
          try {
            const data = JSON.parse(xhr.responseText);
            if (data?.error) err = data.error;
          } catch {}
          reject(new Error(err));
        };

        xhr.onerror = () => {
          reject(new Error("Network connection error during audio transcription. Please click Retry."));
        };

        xhr.ontimeout = () => {
          reject(new Error("Audio transcription request timed out. Please click Retry."));
        };

        const formData = new FormData();
        formData.append("audio", file, file.name);
        formData.append("granularity", granularity);
        formData.append("timeOffset", String(timeOffset));
        xhr.send(formData);
      };

      // 1. If we have an existing sessionId from chunked upload, transcribe via /api/transcribe-session
      if (sessionId) {
        const xhrSession = new XMLHttpRequest();
        xhrSession.open("POST", "/api/transcribe-session");
        xhrSession.setRequestHeader("Content-Type", "application/json");
        xhrSession.timeout = 120000;

        xhrSession.onload = () => {
          const contentType = xhrSession.getResponseHeader("content-type") || "";
          const isHtml = contentType.includes("text/html") || xhrSession.responseText.trim().startsWith("<");

          if (!isHtml && xhrSession.status >= 200 && xhrSession.status < 300) {
            try {
              const data = JSON.parse(xhrSession.responseText);
              if (data?.transcript) {
                return resolve(String(data.transcript).trim());
              }
            } catch {}
          }
          console.warn("Direct session endpoint did not return transcript, trying direct upload fallback...");
          uploadDirectFile();
        };

        xhrSession.onerror = () => {
          console.warn("Session endpoint network error, falling back to direct upload...");
          uploadDirectFile();
        };

        xhrSession.ontimeout = () => {
          console.warn("Session endpoint timed out, falling back to direct upload...");
          uploadDirectFile();
        };

        try {
          xhrSession.send(
            JSON.stringify({
              sessionId,
              granularity,
              timeOffset,
            })
          );
        } catch {
          uploadDirectFile();
        }
      } else {
        uploadDirectFile();
      }
    });
  };

  /**
   * Main Transcribe Handler
   * Sequentially uploads each audio with real-time percentage progress bar,
   * then streams timestamps live line-by-line as Gemini generates them!
   */
  const handleTranscribe = async () => {
    if (files.length === 0) return;

    setErrorMessage(null);
    setLiveLines([]);
    setLiveLatestLine("");

    const allTranscriptParts: string[] = [];
    let currentCumulativeOffset = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const currentFile = files[i];
        setActivePartIndex(i);

        const partLabel = files.length > 1 ? `Part ${i + 1}/${files.length} (${currentFile.name})` : currentFile.name;
        const offsetMin = Math.floor(currentCumulativeOffset / 60);
        const offsetSec = Math.round(currentCumulativeOffset % 60);
        const offsetString = `[${offsetMin}:${String(offsetSec).padStart(2, "0")}]`;

        // PHASE 1: UPLOAD WITH REAL PROGRESS PERCENTAGE
        setStatus("uploading");
        setUploadProgress({
          loaded: 0,
          total: currentFile.size,
          percent: 0,
          speed: "Starting...",
        });
        setStatusMessage(
          files.length > 1
            ? `Uploading ${partLabel} (offset ${offsetString})...`
            : `Uploading audio (${(currentFile.size / (1024 * 1024)).toFixed(1)} MB)...`
        );

        let sessionId = "";
        try {
          const uploadRes = await uploadAudioWithProgress(currentFile.file, (p) => {
            setUploadProgress(p);
            setStatusMessage(
              `Uploading ${partLabel}... ${p.percent}% (${(p.loaded / (1024 * 1024)).toFixed(1)} MB / ${(p.total / (1024 * 1024)).toFixed(1)} MB • ${p.speed})`
            );
          });
          sessionId = uploadRes.sessionId;
        } catch (uploadErr: any) {
          console.warn("Chunked upload failed:", uploadErr);
          // Only attempt direct synchronous upload if file is small enough (< 20MB) to not hit 32MB proxy limits
          if (currentFile.file.size <= 20 * 1024 * 1024) {
            setStatus("transcribing");
            setStatusMessage(`Processing ${partLabel} with Gemini AI...`);
            const fallbackText = await fallbackDirectTranscribe(currentFile.file, currentCumulativeOffset);
            if (fallbackText) {
              allTranscriptParts.push(fallbackText);
              setTranscript(allTranscriptParts.join("\n"));
            }
            currentCumulativeOffset += Math.max(10, Math.ceil(currentFile.duration || 10));
            continue;
          } else {
            throw new Error(`Upload of "${currentFile.name}" failed: ${uploadErr?.message || "Network transfer interrupted"}. Please check your connection and click Retry Transcription.`);
          }
        }

        // PHASE 2: LIVE STREAMING TRANSCRIPTION WITH TIMELAPSE TIMESTAMPS
        setStatus("transcribing");
        setStatusMessage(
          `⚡ Gemini AI connected! Listening to ${partLabel} & streaming timestamps live...`
        );

        let partTranscript = "";
        try {
          partTranscript = await streamTranscribe(
            sessionId,
            currentCumulativeOffset,
            (chunkData) => {
              // Extract timestamp lines from raw text streamed so far and clean into standard [M:SS]
              const cleanedLines: string[] = [];
              const split = chunkData.rawSoFar.split(/\r?\n/);

              for (const line of split) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Match [M:SS], [M:SS.mmm], [H:MM:SS], or unbracketed M:SS
                const m = trimmed.match(/^\[?(\d{1,2}):(\d{2})(?:\.\d+)?\]?[:\s-]*(.*)$/);
                if (m) {
                  const mins = parseInt(m[1], 10);
                  const secs = parseInt(m[2], 10);
                  const text = m[3].replace(/^\[.*?\]\s*/, "").trim();
                  if (text) {
                    const subPhrases = splitIntoMicroPhrasesClient(text);
                    if (subPhrases.length > 1) {
                      subPhrases.forEach((sp, spIdx) => {
                        const calculatedSec = mins * 60 + secs + spIdx * 2;
                        const cM = Math.floor(calculatedSec / 60);
                        const cS = calculatedSec % 60;
                        cleanedLines.push(`[${cM}:${String(cS).padStart(2, "0")}] ${sp}`);
                      });
                    } else {
                      cleanedLines.push(`[${mins}:${String(secs).padStart(2, "0")}] ${text}`);
                    }
                  }
                }
              }

              if (cleanedLines.length > 0) {
                setLiveLines(cleanedLines);
                setLiveLatestLine(cleanedLines[cleanedLines.length - 1] || "");

                // Live preview in main transcript
                const combinedLive = [...allTranscriptParts, ...cleanedLines].join("\n");
                setTranscript(combinedLive);
              } else if (chunkData.latestLine || chunkData.chunk) {
                setLiveLatestLine(chunkData.latestLine || chunkData.chunk);
              }
            },
            (msg) => {
              if (msg) setStatusMessage(msg);
            }
          );
        } catch (streamErr: any) {
          console.warn("Streaming encountered an error, falling back to direct POST:", streamErr);
          setStatusMessage(`Re-syncing ${partLabel} with backup transcription engine...`);
          partTranscript = await fallbackDirectTranscribe(currentFile.file, currentCumulativeOffset, sessionId);
        }

        if (partTranscript) {
          allTranscriptParts.push(partTranscript);
          setTranscript(allTranscriptParts.join("\n"));
        }

        // Calculate next offset
        let partDuration = currentFile.duration;
        if (!partDuration || isNaN(partDuration) || partDuration <= 0) {
          const lines = partTranscript.split("\n");
          for (let l = lines.length - 1; l >= 0; l--) {
            const m = lines[l].match(/^\[(\d{1,2}):(\d{2})\]/);
            if (m) {
              const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
              partDuration = Math.max(sec - currentCumulativeOffset + 2, 5);
              break;
            }
          }
          if (!partDuration) partDuration = 10;
        }

        currentCumulativeOffset += Math.ceil(partDuration);
      }

      setStatus("formatting");
      setStatusMessage("Finalizing unified [M:SS] chronological transcript...");

      const finalUnifiedTranscript = allTranscriptParts.join("\n");
      setTranscript(finalUnifiedTranscript);
      setStatus("done");
      setStatusMessage("");
      setUploadProgress(null);
    } catch (err: any) {
      console.error("Transcription error:", err);
      setStatus("error");
      setErrorMessage(err?.message || "An unexpected error occurred during transcription. Please try again.");
      setUploadProgress(null);
    }
  };

  const handleSeekFromTranscript = (seconds: number) => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.seekTo(seconds);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col font-sans text-neutral-900 antialiased selection:bg-neutral-900 selection:text-white">
      {/* Top Navigation */}
      <header className="w-full bg-white border-b border-neutral-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-neutral-900 flex items-center justify-center text-white shadow-xs">
              <FileAudio className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight text-neutral-900">
                Audio Timestamp Transcriber
              </h1>
              <p className="text-xs text-neutral-500">
                High-Speed AI Transcriber • [M:SS] Sentence & Video Cut Timestamps
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {files.length > 0 && (
              <span className="text-xs font-medium text-neutral-500 bg-neutral-100 px-2.5 py-1 rounded-full border border-neutral-200">
                {files.length} {files.length === 1 ? "Audio" : "Audios"} Loaded
              </span>
            )}
            {status === "transcribing" && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200 animate-pulse">
                <Radio className="w-3.5 h-3.5 text-emerald-600 animate-ping" />
                Live Streaming
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8">
        <div className="space-y-6">
          {/* Header Description */}
          <div className="text-center sm:text-left">
            <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
              Transcribe Audio with [M:SS] Timestamps
            </h2>
            <p className="text-sm text-neutral-500 mt-1 max-w-2xl leading-relaxed">
              Upload single or multiple audio files (MP3, WAV, M4A, up to 150MB). Chunked upload engine reliably handles large 40MB+ files without proxy timeouts or size errors!
            </p>
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div
              id="global-error-banner"
              className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-800 text-sm"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-600" />
              <div className="flex-1">
                <p className="font-semibold">Transcription Failed</p>
                <p className="text-xs text-red-700 mt-0.5">{errorMessage}</p>
                <div className="flex items-center gap-2.5 mt-2">
                  <button
                    id="btn-retry-transcribe"
                    type="button"
                    onClick={handleTranscribe}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-medium cursor-pointer shadow-xs transition-colors"
                  >
                    Retry Transcription
                  </button>
                  <button
                    id="btn-dismiss-error"
                    type="button"
                    onClick={() => setErrorMessage(null)}
                    className="text-xs font-medium text-red-600 hover:text-red-900 underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Section 1: File Upload & Audio Player */}
          <div className="bg-white border border-neutral-200 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-100">
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                1. Audio Input {files.length > 0 && `(${files.length} file${files.length > 1 ? "s" : ""})`}
              </span>
              {files.length > 0 && (
                <span className="text-xs text-neutral-500">
                  Ready to process (Max 150MB per file)
                </span>
              )}
            </div>

            {/* Dropzone with Multi-File Queue */}
            <AudioDropzone
              files={files}
              onFilesAdd={handleFilesAdd}
              onFileRemove={handleFileRemove}
              onFileMove={handleFileMove}
              onFilesClear={handleFilesClear}
              disabled={status === "uploading" || status === "transcribing" || status === "formatting"}
            />

            {/* Audio Player if files selected */}
            {files.length > 0 && (
              <div className="pt-1">
                <AudioPlayer ref={audioPlayerRef} files={files} />
              </div>
            )}

            {/* Audio Frequency Pause Cut Banner */}
            <div className="pt-2 border-t border-neutral-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-neutral-800">
                    Audio Pause Detection:
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                    ⚡ 100ms Frequency Cut Mode
                  </span>
                </div>
                <p className="text-[11px] text-neutral-500 mt-0.5">
                  Line breaks happen strictly when there is a real audio frequency pause or silence cut (≥ 100ms) in the audio track.
                </p>
              </div>

              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 bg-neutral-100 px-3 py-1.5 rounded-lg border border-neutral-200">
                <Radio className="w-3.5 h-3.5 text-emerald-600" />
                <span>100ms Waveform Silence Cuts</span>
              </div>
            </div>

            {/* Action Bar */}
            <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="text-xs text-neutral-500 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-neutral-400 flex-shrink-0" />
                <span>
                  {files.length > 1
                    ? `Sequential Mode: Part 1 starts at [0:00]. Part 2 continues from Part 1's end timestamp.`
                    : `Ultra-fast AI transcription with real-time streaming and precise [M:SS] line-by-line timestamps.`}
                </span>
              </div>

              <button
                id="btn-start-transcribe"
                type="button"
                onClick={handleTranscribe}
                disabled={
                  files.length === 0 ||
                  status === "uploading" ||
                  status === "transcribing" ||
                  status === "formatting"
                }
                className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all shadow-xs ${
                  files.length === 0 ||
                  status === "uploading" ||
                  status === "transcribing" ||
                  status === "formatting"
                    ? "bg-neutral-200 text-neutral-400 cursor-not-allowed"
                    : "bg-neutral-900 hover:bg-neutral-800 text-white cursor-pointer active:scale-[0.99]"
                }`}
              >
                {status === "uploading" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Uploading Audio ({uploadProgress?.percent ?? 0}%)...</span>
                  </>
                ) : status === "transcribing" ? (
                  <>
                    <Zap className="w-4 h-4 text-amber-300 animate-bounce" />
                    <span>Live Transcribing ({elapsedSeconds}s)...</span>
                  </>
                ) : status === "formatting" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Structuring Transcripts...</span>
                  </>
                ) : (
                  <>
                    <span>
                      {files.length > 1
                        ? `Transcribe All ${files.length} Audios in Sequence`
                        : "Transcribe Audio"}
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>

          {/* REAL-TIME UPLOAD PROGRESS CARD */}
          {status === "uploading" && (
            <div
              id="upload-progress-card"
              className="bg-white border border-blue-200 rounded-2xl p-6 sm:p-7 shadow-xs space-y-4 animate-fade-in"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                    <UploadCloud className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-900">
                      Uploading Audio to Server
                    </h3>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {statusMessage}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-bold font-mono text-blue-600">
                    {uploadProgress?.percent ?? 0}%
                  </span>
                </div>
              </div>

              {/* High-visibility animated progress bar */}
              <div className="w-full bg-neutral-100 rounded-full h-3.5 overflow-hidden p-0.5 border border-neutral-200">
                <div
                  className="bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-600 h-full rounded-full transition-all duration-200 shadow-xs"
                  style={{ width: `${Math.max(3, uploadProgress?.percent ?? 0)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-neutral-500 pt-1">
                <span>
                  {uploadProgress
                    ? `${(uploadProgress.loaded / (1024 * 1024)).toFixed(1)} MB of ${(uploadProgress.total / (1024 * 1024)).toFixed(1)} MB`
                    : "Preparing upload..."}
                </span>
                <span className="font-mono text-neutral-600">
                  {uploadProgress?.speed ? `Speed: ${uploadProgress.speed}` : ""} • Elapsed: {elapsedSeconds}s
                </span>
              </div>
            </div>
          )}

          {/* LIVE STREAMING TIMELINE / TIMELAPSE CARD */}
          {status === "transcribing" && (
            <div
              id="live-streaming-card"
              className="bg-neutral-900 text-white rounded-2xl p-6 sm:p-7 shadow-md space-y-4 border border-neutral-800 animate-fade-in"
            >
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-neutral-800 flex items-center justify-center text-emerald-400 border border-neutral-700">
                    <Radio className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">
                        Live AI Timestamp Generation
                      </h3>
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded-full border border-emerald-800">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                        Streaming
                      </span>
                    </div>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      {statusMessage}
                    </p>
                  </div>
                </div>

                {/* Animated wave bars */}
                <div className="flex items-end gap-1 h-6">
                  <span className="w-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:0ms] h-3" />
                  <span className="w-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:150ms] h-6" />
                  <span className="w-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:300ms] h-4" />
                  <span className="w-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:200ms] h-5" />
                  <span className="w-1 bg-emerald-400 rounded-full animate-bounce [animation-delay:100ms] h-3" />
                </div>
              </div>

              {/* Real-time Timestamps Ticker / Terminal Window */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-neutral-400 px-1">
                  <span>
                    Real-time speech stream ({liveLines.length} timestamp{liveLines.length === 1 ? "" : "s"} generated):
                  </span>
                  <span className="font-mono text-emerald-400">
                    ⏱ Elapsed: {elapsedSeconds}s
                  </span>
                </div>

                <div
                  ref={liveTerminalRef}
                  className="bg-black/60 rounded-xl p-4 border border-neutral-800/80 font-mono text-xs max-h-56 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-neutral-700"
                >
                  {liveLines.length === 0 ? (
                    <div className="py-2.5 space-y-2">
                      <div className="flex items-center gap-2 text-neutral-400 text-xs italic">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                        <span>AI acoustic engine listening & detecting speech cuts...</span>
                      </div>
                      {liveLatestLine && (
                        <div className="text-emerald-300 font-mono text-xs pl-5 animate-pulse flex items-center gap-1">
                          <span>{liveLatestLine}</span>
                          <span className="inline-block w-1.5 h-3.5 bg-emerald-400 animate-ping" />
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {liveLines.map((line, idx) => {
                        const isLatest = idx === liveLines.length - 1;
                        return (
                          <div
                            key={idx}
                            className={`flex items-start gap-2.5 py-0.5 transition-colors ${
                              isLatest ? "text-emerald-300 font-medium" : "text-neutral-300"
                            }`}
                          >
                            <span className="text-amber-400 font-semibold select-none flex-shrink-0">
                              {line.substring(0, line.indexOf("]") + 1)}
                            </span>
                            <span className="flex-1 break-words">
                              {line.substring(line.indexOf("]") + 1).trim()}
                              {isLatest && <span className="inline-block w-1.5 h-3.5 bg-emerald-400 ml-1 animate-pulse" />}
                            </span>
                          </div>
                        );
                      })}
                      {liveLatestLine && !liveLines[liveLines.length - 1]?.includes(liveLatestLine) && (
                        <div className="flex items-start gap-2.5 py-0.5 text-emerald-400/80 font-mono text-xs italic">
                          <span className="text-neutral-500">...</span>
                          <span className="flex-1 break-words">
                            {liveLatestLine}
                            <span className="inline-block w-1.5 h-3.5 bg-emerald-400 ml-1 animate-ping" />
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Section 2: Timestamped Transcript Output (Shown even while live streaming so user sees it live!) */}
          {transcript && (
            <div className="space-y-3 animate-fade-in">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    2. Transcript Output {files.length > 1 && `(${files.length} Audios Sequenced)`}
                  </span>
                  {status === "transcribing" && (
                    <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full animate-pulse">
                      Updating Live
                    </span>
                  )}
                </div>
                <span className="text-xs text-neutral-500">
                  Click any timestamp to seek & play audio
                </span>
              </div>

              <TranscriptEditor
                transcript={transcript}
                onChange={setTranscript}
                onReset={handleResetAll}
                onSeek={handleSeekFromTranscript}
                filename={files.map((f) => f.name).join(" + ") || "audio"}
                isLiveStreaming={status === "transcribing"}
              />
            </div>
          )}

          {/* Example Format Reference Box when no transcript generated yet */}
          {!transcript && status === "idle" && (
            <div id="format-preview-card" className="border border-neutral-200 bg-white rounded-xl p-5 shadow-xs">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">
                  🎬 Video B-Roll / Image-Cut Format & Multi-Audio Continuity
                </span>
                <span className="text-[11px] text-neutral-400 font-mono">Sequential Timestamps</span>
              </div>
              <div className="bg-neutral-50 rounded-lg p-3.5 border border-neutral-200 font-mono text-xs text-neutral-700 space-y-1">
                <div className="text-neutral-400 font-sans italic text-[11px]">// Audio 1 (Part 1) — Scene by scene image cuts:</div>
                <div>[0:00] Back in 2015</div>
                <div>[0:02] He was completely broke</div>
                <div>[0:04] But then he discovered this simple trick</div>
                <div>[0:07] And everything changed.</div>
                <div className="text-emerald-700 font-sans italic text-[11px] pt-1.5 border-t border-neutral-200 mt-1.5">
                  // Audio 2 (Part 2) — Continues right from the end of Audio 1:
                </div>
                <div>[1:15] Suddenly someone knocked on the door</div>
                <div>[1:18] So he got up quickly</div>
                <div>[1:21] Because he was not expecting anyone.</div>
              </div>
              <p className="text-xs text-neutral-500 mt-2.5">
                Optimized for video editors! Cuts are automatically made at <strong>transitions</strong> (<em>but then, however, so, because, suddenly, meanwhile</em>), <strong>conjunctions</strong> (<em>and, or</em>), <strong>commas</strong>, and <strong>spoken pauses</strong> so you have an exact timestamp for every image and B-roll change.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-neutral-200 bg-white py-4 text-center text-xs text-neutral-400 mt-auto">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Audio Timestamp Transcriber</span>
          <span>Supports files up to 150MB • Chunked upload engine • [M:SS] Video cuts</span>
        </div>
      </footer>
    </div>
  );
}
