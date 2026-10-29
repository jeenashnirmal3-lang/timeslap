import React, { useState, useRef } from "react";
import {
  UploadCloud,
  FileAudio,
  AlertCircle,
  X,
  Sparkles,
  Plus,
  ArrowUp,
  ArrowDown,
  Clock,
  Layers,
} from "lucide-react";
import { AudioFileInfo } from "../types";
import { generateSampleAudioFile } from "../utils/audioSample";

interface AudioDropzoneProps {
  files: AudioFileInfo[];
  onFilesAdd: (newFiles: AudioFileInfo[]) => void;
  onFileRemove: (index: number) => void;
  onFileMove?: (fromIndex: number, toIndex: number) => void;
  onFilesClear: () => void;
  disabled?: boolean;
}

export const AudioDropzone: React.FC<AudioDropzoneProps> = ({
  files,
  onFilesAdd,
  onFileRemove,
  onFileMove,
  onFilesClear,
  disabled = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [generatingSample, setGeneratingSample] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addMoreRef = useRef<HTMLInputElement>(null);

  const validateAndProcessFiles = async (fileList: FileList | File[]) => {
    setErrorMsg(null);
    const validExtensions = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm", ".flac"];
    const maxSize = 150 * 1024 * 1024; // 150MB
    const processed: AudioFileInfo[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      const isAudioMime = file.type.startsWith("audio/") || file.type === "video/mp4";
      const isValidExt = validExtensions.includes(ext);

      if (!isAudioMime && !isValidExt) {
        setErrorMsg(`"${file.name}" is not a valid audio format. Please use MP3, WAV, or M4A.`);
        continue;
      }

      if (file.size > maxSize) {
        setErrorMsg(`"${file.name}" is too large. Maximum supported audio file size is 150MB.`);
        continue;
      }

      const objectUrl = URL.createObjectURL(file);
      const audioObj = new Audio(objectUrl);

      const duration = await new Promise<number | undefined>((resolve) => {
        audioObj.onloadedmetadata = () => resolve(audioObj.duration);
        audioObj.onerror = () => resolve(undefined);
        setTimeout(() => resolve(undefined), 3000);
      });

      processed.push({
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        file,
        name: file.name,
        size: file.size,
        type: file.type || ext.replace(".", "audio/"),
        url: objectUrl,
        duration: duration && !isNaN(duration) ? duration : undefined,
      });
    }

    if (processed.length > 0) {
      onFilesAdd(processed);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndProcessFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled) setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndProcessFiles(e.target.files);
      e.target.value = ""; // reset so same file can be selected again
    }
  };

  const handleSampleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || generatingSample) return;
    try {
      setGeneratingSample(true);
      const sampleFile = await generateSampleAudioFile();
      await validateAndProcessFiles([sampleFile]);
    } catch (err) {
      console.error("Failed to generate sample audio", err);
    } finally {
      setGeneratingSample(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatTime = (secs?: number) => {
    if (secs === undefined || isNaN(secs)) return "--:--";
    const rounded = Math.round(secs);
    const m = Math.floor(rounded / 60);
    const s = rounded % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Compute start offset and total duration
  let cumulativeSeconds = 0;
  const filesWithOffsets = files.map((f) => {
    const startSec = cumulativeSeconds;
    const dur = f.duration || 0;
    cumulativeSeconds += dur;
    return {
      ...f,
      startOffset: startSec,
      endOffset: dur > 0 ? startSec + dur : undefined,
    };
  });

  const totalDuration = cumulativeSeconds;

  return (
    <div className="w-full space-y-3">
      {/* Hidden inputs for file pickers */}
      <input
        id="audio-files-input"
        ref={inputRef}
        type="file"
        multiple
        accept=".mp3,.wav,.m4a,audio/*"
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled}
      />
      <input
        id="audio-add-more-input"
        ref={addMoreRef}
        type="file"
        multiple
        accept=".mp3,.wav,.m4a,audio/*"
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled}
      />

      {files.length === 0 ? (
        <div
          id="dropzone-container"
          onClick={() => !disabled && inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 ${
            isDragOver
              ? "border-neutral-900 bg-neutral-100/80 scale-[1.005]"
              : "border-neutral-300 hover:border-neutral-400 bg-white"
          } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <div className="flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-700">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div>
              <p className="text-base font-semibold text-neutral-800">
                Click to upload or drag & drop audio files here
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Upload 1 or multiple audio files (e.g. Part 1, Part 2). Audio 2 will continue with sequential timestamps!
              </p>
              <p className="text-[11px] text-neutral-400 mt-0.5">
                Supports MP3, WAV, M4A, AAC, OGG, WEBM, FLAC (up to 150 MB each)
              </p>
            </div>
            <div className="pt-2">
              <button
                id="btn-sample-audio"
                type="button"
                onClick={handleSampleClick}
                disabled={disabled || generatingSample}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5 text-neutral-600" />
                {generatingSample ? "Creating sample..." : "Test with sample audio"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* Header summary of selected files */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-600 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-neutral-500" />
                Uploaded Audio Queue ({files.length})
              </span>
              {totalDuration > 0 && (
                <span className="text-xs text-neutral-500 bg-neutral-200/60 px-2 py-0.5 rounded-full font-mono font-medium">
                  Total: {formatTime(totalDuration)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                id="btn-add-more-audio"
                type="button"
                onClick={() => addMoreRef.current?.click()}
                disabled={disabled}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-700 bg-white border border-neutral-300 hover:bg-neutral-50 rounded-lg shadow-2xs transition-colors"
              >
                <Plus className="w-3.5 h-3.5 text-neutral-600" />
                Add Another Audio
              </button>
              <button
                id="btn-clear-all-files"
                type="button"
                onClick={onFilesClear}
                disabled={disabled}
                className="px-2 py-1 text-xs text-neutral-500 hover:text-red-600 transition-colors"
              >
                Clear all
              </button>
            </div>
          </div>

          {/* List of files with sequential timestamp continuation indicator */}
          <div className="space-y-2">
            {filesWithOffsets.map((fileInfo, index) => (
              <div
                key={fileInfo.id || index}
                id={`audio-file-row-${index}`}
                className="border border-neutral-200 bg-white rounded-xl p-3.5 flex items-center justify-between shadow-2xs transition-all hover:border-neutral-300"
              >
                <div className="flex items-center space-x-3 overflow-hidden min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-neutral-100 flex items-center justify-center text-neutral-700 flex-shrink-0 font-mono text-xs font-bold">
                    {index + 1}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-neutral-900 truncate max-w-[280px] sm:max-w-md">
                        {fileInfo.name}
                      </p>
                      <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.2 bg-neutral-100 text-neutral-600 rounded">
                        Part {index + 1}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-neutral-500 mt-1 flex-wrap font-mono">
                      <span className="text-neutral-600 font-medium">
                        [{formatTime(fileInfo.startOffset)}
                        {fileInfo.endOffset !== undefined ? ` → ${formatTime(fileInfo.endOffset)}]` : "]"}
                      </span>
                      <span>•</span>
                      <span>{formatFileSize(fileInfo.size)}</span>
                      {fileInfo.duration && (
                        <>
                          <span>•</span>
                          <span>Length: {formatTime(fileInfo.duration)}</span>
                        </>
                      )}
                      {index > 0 && (
                        <span className="text-[11px] font-sans font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200/60">
                          Continues from Part {index}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* File controls: reorder and remove */}
                <div className="flex items-center gap-1.5 ml-3 flex-shrink-0">
                  {onFileMove && files.length > 1 && (
                    <div className="flex items-center bg-neutral-100 rounded-lg p-0.5">
                      <button
                        type="button"
                        onClick={() => onFileMove(index, index - 1)}
                        disabled={disabled || index === 0}
                        title="Move Up"
                        className="p-1 text-neutral-500 hover:text-neutral-900 disabled:opacity-30 disabled:cursor-not-allowed rounded"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onFileMove(index, index + 1)}
                        disabled={disabled || index === files.length - 1}
                        title="Move Down"
                        className="p-1 text-neutral-500 hover:text-neutral-900 disabled:opacity-30 disabled:cursor-not-allowed rounded"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => onFileRemove(index)}
                    disabled={disabled}
                    className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
                    title="Remove audio"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {files.length > 1 && (
            <div className="p-2.5 bg-neutral-50 rounded-lg border border-neutral-200 text-xs text-neutral-600 flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-neutral-500 flex-shrink-0" />
              <span>
                <strong>Sequential Timestamps Active:</strong> Part 1 will start at [0:00]. Part 2 and subsequent audios will automatically continue from the exact end of the previous audio.
              </span>
            </div>
          )}
        </div>
      )}

      {errorMsg && (
        <div
          id="upload-validation-error"
          className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
