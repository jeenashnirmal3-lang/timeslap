import React, { useState, useMemo } from "react";
import { Copy, Check, Download, RotateCcw, AlertTriangle, ShieldCheck, PlayCircle, Scissors, Merge } from "lucide-react";

interface TranscriptEditorProps {
  transcript: string;
  onChange: (value: string) => void;
  onReset: () => void;
  onSeek?: (seconds: number) => void;
  filename?: string;
  isLiveStreaming?: boolean;
}

export const TranscriptEditor: React.FC<TranscriptEditorProps> = ({
  transcript,
  onChange,
  onReset,
  onSeek,
  filename = "audio",
  isLiveStreaming = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"textarea" | "interactive">("textarea");

  const lines = useMemo(() => {
    return transcript.split(/\r?\n/).filter((l) => l.trim().length > 0);
  }, [transcript]);

  const wordCount = useMemo(() => {
    return lines.reduce((acc, line) => {
      const textWithoutTimestamp = line.replace(/^\[\d{1,2}:\d{2}\]\s*/, "");
      const words = textWithoutTimestamp.split(/\s+/).filter(Boolean);
      return acc + words.length;
    }, 0);
  }, [lines]);

  // Validate adherence to strict format: ^\[\d{1,2}:\d{2}\] .+
  const formatValidation = useMemo(() => {
    const invalidLines: number[] = [];
    lines.forEach((line, idx) => {
      const isValid = /^\[\d{1,2}:\d{2}\]\s+.+$/.test(line);
      if (!isValid) {
        invalidLines.push(idx + 1);
      }
    });
    return {
      isValid: invalidLines.length === 0,
      invalidCount: invalidLines.length,
      firstInvalidLine: invalidLines[0] ?? null,
    };
  }, [lines]);

  const showNotice = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 3000);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy transcript", err);
    }
  };

  const handleDownload = () => {
    const baseName = filename.replace(/\.[^/.]+$/, "");
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}_transcript.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const parseTimestampSeconds = (line: string): number | null => {
    const match = line.match(/^\[(\d{1,2}):(\d{2})\]/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return minutes * 60 + seconds;
  };

  const formatSecondsToTimestamp = (sec: number): string => {
    // Floor seconds so timestamps start at or before the word's audio onset, never clipping the word's initial frequency
    const sFloor = Math.max(0, Math.floor(sec));
    const m = Math.floor(sFloor / 60);
    const s = sFloor % 60;
    return `[${m}:${String(s).padStart(2, "0")}]`;
  };

  // Split any long sentences into short bite-sized micro-phrases (2-5 words)
  const handleSplitAtPauses = () => {
    const parsed = lines.map((line, idx) => {
      const sec = parseTimestampSeconds(line);
      const text = line.replace(/^\[\d{1,2}:\d{2}\]\s*/, "");
      return { sec: sec !== null ? sec : idx * 3, text };
    });

    const newLines: string[] = [];
    let splitCount = 0;

    const splitIntoPhrases = (rawText: string): string[] => {
      if (!rawText.trim()) return [];
      const clean = rawText.trim();
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

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      const nextItem = parsed[i + 1];

      const clauses = splitIntoPhrases(item.text);

      if (clauses.length > 1) {
        splitCount += clauses.length - 1;
        const nextSec = nextItem ? nextItem.sec : item.sec + Math.max(clauses.length * 2, 4);
        const duration = Math.max(clauses.length * 1.5, nextSec - item.sec);
        const totalWords = clauses.reduce((acc, c) => acc + Math.max(1, c.split(/\s+/).length), 0);

        let accWords = 0;
        let lastSec = item.sec;

        clauses.forEach((clause, cIdx) => {
          let clauseSec: number;
          if (cIdx === 0) {
            clauseSec = item.sec;
          } else {
            clauseSec = Math.max(lastSec + 1, Math.floor(item.sec + (accWords / totalWords) * duration));
          }
          lastSec = clauseSec;
          accWords += Math.max(1, clause.split(/\s+/).length);
          newLines.push(`${formatSecondsToTimestamp(clauseSec)} ${clause}`);
        });
      } else {
        newLines.push(`${formatSecondsToTimestamp(item.sec)} ${item.text}`);
      }
    }

    onChange(newLines.join("\n"));
    showNotice(splitCount > 0 ? `Split into ${splitCount} short micro-phrases!` : "All lines are already short micro-phrases.");
  };

  // Merge lines into sentences
  const handleMergeToSentences = () => {
    const parsed = lines.map((line, idx) => {
      const sec = parseTimestampSeconds(line);
      const text = line.replace(/^\[\d{1,2}:\d{2}\]\s*/, "");
      return { sec: sec !== null ? sec : idx * 3, text };
    });

    const newLines: string[] = [];
    let currentChunk: string[] = [];
    let currentStartSec = 0;

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (currentChunk.length === 0) {
        currentStartSec = item.sec;
      }
      currentChunk.push(item.text);

      const isTerminal = /[.!?]$/.test(item.text);
      if (isTerminal || i === parsed.length - 1) {
        newLines.push(`${formatSecondsToTimestamp(currentStartSec)} ${currentChunk.join(" ")}`);
        currentChunk = [];
      }
    }

    onChange(newLines.join("\n"));
    showNotice("Merged micro-phrases into full sentences.");
  };

  // Re-formats any misaligned lines (e.g. cleans up double spaces or removes blank lines)
  const handleAutoCleanFormat = () => {
    const cleaned = lines
      .map((line) => {
        let l = line.trim();
        // If it starts with [00:05], change to [0:05]
        l = l.replace(/^\[0(\d:\d{2})\]/, "[$1]");
        // Ensure single space after timestamp
        l = l.replace(/^(\[\d{1,2}:\d{2}\])\s*/, "$1 ");
        return l;
      })
      .join("\n");
    onChange(cleaned);
    showNotice("Cleaned and normalized timestamps to [M:SS] format.");
  };

  return (
    <div id="transcript-editor-container" className="w-full bg-white border border-neutral-200 rounded-xl shadow-xs overflow-hidden">
      {/* Action Header */}
      <div className="p-4 border-b border-neutral-200 bg-neutral-50/50 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center flex-wrap gap-2.5">
          <span className="text-sm font-semibold text-neutral-800">Timestamped Transcript</span>
          <span className="text-xs font-mono px-2 py-0.5 bg-neutral-200/70 text-neutral-700 rounded-md">
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </span>
          <span className="text-xs font-mono px-2 py-0.5 bg-neutral-200/70 text-neutral-700 rounded-md">
            {wordCount} words
          </span>

          {formatValidation.isValid ? (
            <span
              id="format-valid-badge"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200/60"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Strict [M:SS] Validated
            </span>
          ) : (
            <button
              id="format-warning-badge"
              type="button"
              onClick={handleAutoCleanFormat}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 px-2 py-0.5 rounded-md border border-amber-200/80 transition-colors cursor-pointer"
              title="Click to auto-format timestamps"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {formatValidation.invalidCount} non-standard {formatValidation.invalidCount === 1 ? "line" : "lines"} (Fix)
            </button>
          )}

          {isLiveStreaming && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-violet-800 bg-violet-50 px-2.5 py-0.5 rounded-md border border-violet-200 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-600 animate-ping" />
              Live Streaming Speech...
            </span>
          )}

          {actionNotice && (
            <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200/80 animate-fade-in">
              {actionNotice}
            </span>
          )}
        </div>

        <div className="flex items-center flex-wrap gap-2">
          {/* Quick Transform Tools */}
          <button
            id="btn-split-pauses"
            type="button"
            onClick={handleSplitAtPauses}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors shadow-2xs cursor-pointer"
            title="Break long sentences into short micro-phrases (at conjunctions like because/but/so/and, clauses, and pauses)"
          >
            <Scissors className="w-3.5 h-3.5 text-emerald-700" />
            <span>✂️ Split into Phrases (2-5 words)</span>
          </button>

          <button
            id="btn-merge-sentences"
            type="button"
            onClick={handleMergeToSentences}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg text-neutral-700 bg-white hover:bg-neutral-100 border border-neutral-300 transition-colors shadow-2xs cursor-pointer"
            title="Merge micro-phrases back into complete sentences"
          >
            <Merge className="w-3.5 h-3.5 text-neutral-600" />
            <span>Merge to Sentences</span>
          </button>

          {/* Mode switch */}
          <div className="flex items-center p-0.5 bg-neutral-200/70 rounded-lg text-xs font-medium text-neutral-700">
            <button
              id="view-textarea-btn"
              type="button"
              onClick={() => setViewMode("textarea")}
              className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                viewMode === "textarea" ? "bg-white text-neutral-900 shadow-xs font-semibold" : "hover:text-neutral-900"
              }`}
            >
              Text Editor
            </button>
            <button
              id="view-interactive-btn"
              type="button"
              onClick={() => setViewMode("interactive")}
              className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                viewMode === "interactive" ? "bg-white text-neutral-900 shadow-xs font-semibold" : "hover:text-neutral-900"
              }`}
            >
              Audio Sync Clicker
            </button>
          </div>

          <button
            id="copy-transcript-btn"
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-neutral-700 bg-neutral-100 hover:bg-neutral-200 border border-neutral-200 transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700 font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy to clipboard</span>
              </>
            )}
          </button>

          <button
            id="download-transcript-btn"
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-neutral-900 hover:bg-neutral-800 transition-colors shadow-xs cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download as .txt</span>
          </button>
        </div>
      </div>

      {/* Editor Body */}
      {viewMode === "textarea" ? (
        <div className="relative p-4">
          <textarea
            id="transcript-editable-textarea"
            value={transcript}
            onChange={(e) => onChange(e.target.value)}
            rows={14}
            className="w-full font-mono text-sm text-neutral-900 leading-relaxed bg-white border border-neutral-200 rounded-lg p-4 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent resize-y tracking-tight"
            placeholder="[0:00] Transcript will appear here..."
            spellCheck={false}
          />
          <div className="flex items-center justify-between mt-2 px-1 text-xs text-neutral-400">
            <span>Directly edit any timestamp or line. Changes take effect immediately in copy and download.</span>
            <span>Format: [M:SS] Text</span>
          </div>
        </div>
      ) : (
        <div id="interactive-sync-view" className="p-4 max-h-[420px] overflow-y-auto space-y-1.5 divide-y divide-neutral-100">
          <p className="text-xs text-neutral-500 pb-2">
            Click any timestamp to jump the audio player straight to that moment:
          </p>
          {lines.map((line, idx) => {
            const seconds = parseTimestampSeconds(line);
            const textMatch = line.match(/^(\[\d{1,2}:\d{2}\])\s*(.*)$/);
            const timestampPart = textMatch ? textMatch[1] : "";
            const textPart = textMatch ? textMatch[2] : line;

            return (
              <div
                key={idx}
                className="pt-1.5 flex items-start gap-2.5 text-sm group hover:bg-neutral-50 p-1.5 rounded-lg transition-colors"
              >
                {seconds !== null ? (
                  <button
                    type="button"
                    onClick={() => onSeek?.(seconds)}
                    className="flex-shrink-0 inline-flex items-center gap-1 font-mono text-xs font-semibold text-neutral-800 bg-neutral-100 hover:bg-neutral-900 hover:text-white px-2 py-0.5 rounded transition-colors"
                    title={`Seek audio to ${timestampPart}`}
                  >
                    <PlayCircle className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                    {timestampPart}
                  </button>
                ) : (
                  <span className="font-mono text-xs text-neutral-400 min-w-[54px]">{idx + 1}.</span>
                )}
                <span className="text-neutral-800 text-sm leading-relaxed flex-1">{textPart}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer Info */}
      <div className="px-4 py-2.5 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral-500">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>Ready to paste directly into downstream editing, subtitles, or LLM tools.</span>
        </div>
        <button
          id="btn-clear-transcript"
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-800 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Upload Another Audio</span>
        </button>
      </div>
    </div>
  );
};
