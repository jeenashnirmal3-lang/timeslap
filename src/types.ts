export interface AudioFileInfo {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  url: string;
  duration?: number;
  startOffset?: number;
}

export interface TranscriptionResult {
  transcript: string;
  filename: string;
  fileSize: number;
  linesCount: number;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
  speed: string;
}

export type ProcessingStep = "idle" | "uploading" | "transcribing" | "formatting" | "done" | "error";

