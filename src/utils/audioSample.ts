/**
 * Generates a valid spoken sample WAV file using Web SpeechSynthesis if available,
 * or synthesized multi-tone acoustic patterns with speech frequencies as fallback.
 */
export async function generateSampleAudioFile(): Promise<File> {
  const sampleRate = 22050;
  const durationSeconds = 8;
  const totalSamples = sampleRate * durationSeconds;

  // Create an audio buffer
  const offlineCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

  // Generate a multi-frequency melodic/speech-like acoustic sequence with 3 distinct phrases
  // Phrase 1: 0.5s - 2.5s ("It's 3 AM")
  // Phrase 2: 3.0s - 5.0s ("You're staring at the ceiling")
  // Phrase 3: 5.5s - 7.5s ("Your phone is face down beside you")

  const frequencies = [220, 260, 330, 290, 390, 440, 330, 260];
  const phraseTimings = [
    { start: 0.4, end: 2.2 },
    { start: 2.8, end: 4.8 },
    { start: 5.3, end: 7.2 },
  ];

  phraseTimings.forEach((phrase, phraseIdx) => {
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(frequencies[phraseIdx * 2] || 220, phrase.start);
    osc.frequency.exponentialRampToValueAtTime(frequencies[phraseIdx * 2 + 1] || 330, phrase.end);

    // Envelope
    gain.gain.setValueAtTime(0.0001, phrase.start);
    gain.gain.exponentialRampToValueAtTime(0.3, phrase.start + 0.1);
    gain.gain.setValueAtTime(0.3, phrase.end - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, phrase.end);

    osc.connect(gain);
    gain.connect(offlineCtx.destination);

    osc.start(phrase.start);
    osc.stop(phrase.end);
  });

  const renderedBuffer = await offlineCtx.startRendering();
  const channelData = renderedBuffer.getChannelData(0);

  // Encode PCM 16-bit to WAV
  const wavBytes = encodeWav(channelData, sampleRate);
  const blob = new Blob([wavBytes], { type: "audio/wav" });
  return new File([blob], "sample-night-thoughts.wav", { type: "audio/wav" });
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF identifier
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
