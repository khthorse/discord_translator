// Wraps raw 16-bit little-endian PCM in a WAV header so any audio tool can read it.
export function pcmToWav(pcm, sampleRate = 48000, channels = 2) {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);

  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // size of the fmt chunk
  header.writeUInt16LE(1, 20); // format 1 = uncompressed PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(channels * bytesPerSample, 32); // block align
  header.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample

  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
