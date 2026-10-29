import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { Play, Pause, RotateCcw, Volume2, VolumeX, SkipForward, SkipBack, Music } from "lucide-react";
import { AudioFileInfo } from "../types";

export interface AudioPlayerHandle {
  seekTo: (globalSeconds: number) => void;
  play: () => void;
  pause: () => void;
}

interface AudioPlayerProps {
  files: AudioFileInfo[];
  onTimeUpdate?: (globalTime: number) => void;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  ({ files, onTimeUpdate }, ref) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [activeIdx, setActiveIdx] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [localTime, setLocalTime] = useState(0);
    const [localDuration, setLocalDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);

    // Compute cumulative offsets for all files
    let cumulative = 0;
    const filesWithOffsets = files.map((f) => {
      const offset = cumulative;
      const dur = f.duration || 0;
      cumulative += dur;
      return { ...f, offset, dur };
    });

    const activeFile = filesWithOffsets[activeIdx] || filesWithOffsets[0];
    const currentOffset = activeFile?.offset || 0;
    const globalCurrentTime = currentOffset + localTime;

    useImperativeHandle(ref, () => ({
      seekTo: (globalSeconds: number) => {
        // Find which file contains globalSeconds
        let targetIdx = 0;
        for (let i = 0; i < filesWithOffsets.length; i++) {
          const item = filesWithOffsets[i];
          const nextItem = filesWithOffsets[i + 1];
          if (nextItem) {
            if (globalSeconds >= item.offset && globalSeconds < nextItem.offset) {
              targetIdx = i;
              break;
            }
          } else {
            targetIdx = i;
          }
        }

        const targetFile = filesWithOffsets[targetIdx];
        const offset = targetFile ? targetFile.offset : 0;
        const relativeSec = Math.max(0, globalSeconds - offset);

        if (targetIdx !== activeIdx) {
          setActiveIdx(targetIdx);
          // Wait for audio src to change then seek
          setTimeout(() => {
            if (audioRef.current) {
              audioRef.current.currentTime = relativeSec;
              setLocalTime(relativeSec);
              audioRef.current.play().catch(() => {});
              setIsPlaying(true);
            }
          }, 150);
        } else {
          if (audioRef.current) {
            audioRef.current.currentTime = relativeSec;
            setLocalTime(relativeSec);
            if (audioRef.current.paused) {
              audioRef.current.play().catch(() => {});
              setIsPlaying(true);
            }
          }
        }
      },
      play: () => {
        audioRef.current?.play().catch(() => {});
        setIsPlaying(true);
      },
      pause: () => {
        audioRef.current?.pause();
        setIsPlaying(false);
      },
    }));

    // Reset when active index changes
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const handleLoadedMetadata = () => {
        setLocalDuration(audio.duration || 0);
      };

      const handleTimeUpdate = () => {
        setLocalTime(audio.currentTime);
        const globalNow = (filesWithOffsets[activeIdx]?.offset || 0) + audio.currentTime;
        onTimeUpdate?.(globalNow);
      };

      const handleEnded = () => {
        // Auto-advance to next audio file if available
        if (activeIdx < files.length - 1) {
          setActiveIdx((prev) => prev + 1);
          setTimeout(() => {
            audioRef.current?.play().catch(() => {});
            setIsPlaying(true);
          }, 100);
        } else {
          setIsPlaying(false);
        }
      };

      audio.addEventListener("loadedmetadata", handleLoadedMetadata);
      audio.addEventListener("timeupdate", handleTimeUpdate);
      audio.addEventListener("ended", handleEnded);

      return () => {
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        audio.removeEventListener("timeupdate", handleTimeUpdate);
        audio.removeEventListener("ended", handleEnded);
      };
    }, [activeIdx, files, filesWithOffsets, onTimeUpdate]);

    const togglePlay = () => {
      if (!audioRef.current) return;
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
      const targetLocal = parseFloat(e.target.value);
      if (audioRef.current) {
        audioRef.current.currentTime = targetLocal;
        setLocalTime(targetLocal);
      }
    };

    const toggleMute = () => {
      if (!audioRef.current) return;
      audioRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    };

    const cyclePlaybackRate = () => {
      if (!audioRef.current) return;
      const rates = [1, 1.25, 1.5, 0.75];
      const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
      const nextRate = rates[nextIdx];
      audioRef.current.playbackRate = nextRate;
      setPlaybackRate(nextRate);
    };

    const formatTime = (secs: number) => {
      const rounded = Math.max(0, Math.round(secs));
      const m = Math.floor(rounded / 60);
      const s = rounded % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    if (files.length === 0) return null;

    return (
      <div id="audio-player-bar" className="w-full bg-white border border-neutral-200 rounded-xl p-3.5 shadow-2xs space-y-2.5">
        <audio ref={audioRef} src={activeFile?.url} preload="metadata" />

        {/* Multi-track switcher header if multiple files */}
        {files.length > 1 && (
          <div className="flex items-center justify-between pb-2 border-b border-neutral-100 flex-wrap gap-2">
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
              <span className="text-[11px] font-semibold uppercase text-neutral-400 mr-1">
                Tracks:
              </span>
              {filesWithOffsets.map((f, idx) => (
                <button
                  key={f.id || idx}
                  id={`track-pill-${idx}`}
                  type="button"
                  onClick={() => {
                    setActiveIdx(idx);
                    setLocalTime(0);
                    setTimeout(() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = 0;
                        if (isPlaying) audioRef.current.play().catch(() => {});
                      }
                    }, 50);
                  }}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-all whitespace-nowrap flex items-center gap-1.5 ${
                    activeIdx === idx
                      ? "bg-neutral-900 text-white font-semibold"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900"
                  }`}
                >
                  <span>Part {idx + 1}</span>
                  <span className="text-[10px] opacity-75 font-mono">
                    [{formatTime(f.offset)}]
                  </span>
                </button>
              ))}
            </div>

            <div className="text-xs text-neutral-500 font-mono">
              Playing: <span className="font-semibold text-neutral-800 truncate inline-block max-w-[150px] align-bottom">{activeFile?.name}</span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          {/* Previous track button if multiple */}
          {files.length > 1 && (
            <button
              type="button"
              onClick={() => {
                if (activeIdx > 0) {
                  setActiveIdx((prev) => prev - 1);
                  setLocalTime(0);
                }
              }}
              disabled={activeIdx === 0}
              className="p-1.5 text-neutral-400 hover:text-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed rounded"
              title="Previous Track"
            >
              <SkipBack className="w-4 h-4" />
            </button>
          )}

          <button
            id="player-toggle-btn"
            type="button"
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-neutral-900 hover:bg-neutral-800 text-white flex items-center justify-center transition-colors flex-shrink-0"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
          </button>

          {/* Next track button if multiple */}
          {files.length > 1 && (
            <button
              type="button"
              onClick={() => {
                if (activeIdx < files.length - 1) {
                  setActiveIdx((prev) => prev + 1);
                  setLocalTime(0);
                }
              }}
              disabled={activeIdx === files.length - 1}
              className="p-1.5 text-neutral-400 hover:text-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed rounded"
              title="Next Track"
            >
              <SkipForward className="w-4 h-4" />
            </button>
          )}

          <button
            id="player-restart-btn"
            type="button"
            onClick={() => {
              if (audioRef.current) {
                audioRef.current.currentTime = 0;
                setLocalTime(0);
              }
            }}
            className="p-2 text-neutral-500 hover:text-neutral-800 rounded-md transition-colors"
            title="Restart track from 0:00"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          {/* Current Global Timestamp (matching transcript!) */}
          <div className="flex flex-col items-end min-w-[54px]">
            <span className="text-xs font-mono font-bold text-neutral-900">
              {formatTime(globalCurrentTime)}
            </span>
            {files.length > 1 && (
              <span className="text-[10px] font-mono text-neutral-400">
                P{activeIdx + 1}:{formatTime(localTime)}
              </span>
            )}
          </div>

          <input
            id="player-seek-slider"
            type="range"
            min={0}
            max={localDuration || 100}
            step={0.1}
            value={localTime}
            onChange={handleSeek}
            className="flex-1 h-1.5 bg-neutral-200 rounded-lg appearance-none cursor-pointer accent-neutral-900"
          />

          <span className="text-xs font-mono text-neutral-400 min-w-[36px]">
            {formatTime(localDuration)}
          </span>

          <div className="flex items-center gap-1.5 pl-1 border-l border-neutral-200">
            <button
              id="player-rate-btn"
              type="button"
              onClick={cyclePlaybackRate}
              className="text-xs font-mono font-semibold px-2 py-1 rounded text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
              title="Change speed"
            >
              {playbackRate}x
            </button>

            <button
              id="player-mute-btn"
              type="button"
              onClick={toggleMute}
              className="p-1.5 text-neutral-500 hover:text-neutral-800 rounded-md transition-colors"
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  }
);

AudioPlayer.displayName = "AudioPlayer";
