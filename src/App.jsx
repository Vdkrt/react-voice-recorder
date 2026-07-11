import { useEffect, useMemo, useRef, useState } from 'react';
import { buildWavBlob, createNoiseSuppressorNode, formatBytes, formatDuration, processAudioSamples } from './audio';

const INITIAL_SETTINGS = {
  denoiseStrength: 0.7,
  denoiseFrameSize: 128,
  opusBitrate: 32000,
};

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [tracks, setTracks] = useState([]);

  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const noiseSuppressorNodeRef = useRef(null);
  const sampleChunksRef = useRef([]);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stream?.getTracks().forEach((track) => track.stop());
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
      tracks.forEach((track) => URL.revokeObjectURL(track.url));
    };
  }, []);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    timerRef.current = window.setInterval(() => {
      setElapsedTime((value) => value + 1);
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRecording]);

  const resetCapture = () => {
    sampleChunksRef.current = [];
    setElapsedTime(0);
    setLevel(0);
  };

  const startRecording = async () => {
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support microphone access.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new window.AudioContext();
      await audioContext.resume();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const noiseSuppressorNode = await createNoiseSuppressorNode(audioContext);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const peak = input.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        setLevel(peak);
        sampleChunksRef.current.push(new Float32Array(input));
      };

      if (noiseSuppressorNode) {
        sourceNode.connect(noiseSuppressorNode);
        noiseSuppressorNode.connect(processor);
      } else {
        sourceNode.connect(processor);
      }
      processor.connect(audioContext.destination);

      streamRef.current = stream;
      mediaRecorderRef.current = { stream, audioContext, sourceNode, processor };
      noiseSuppressorNodeRef.current = noiseSuppressorNode;
      audioContextRef.current = audioContext;
      processorRef.current = processor;
      resetCapture();
      setIsRecording(true);
    } catch (err) {
      setError(err.message || 'Microphone access was denied.');
    }
  };

  const stopRecording = async () => {
    if (!mediaRecorderRef.current) {
      return;
    }

    const { processor, audioContext, stream, sourceNode } = mediaRecorderRef.current;

    try {
      setIsProcessing(true);
      if (processor) {
        processor.disconnect();
      }
      if (noiseSuppressorNodeRef.current) {
        noiseSuppressorNodeRef.current.disconnect();
      }
      if (sourceNode) {
        sourceNode.disconnect();
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (audioContext) {
        await audioContext.close();
      }

      const fullSamples = mergeFloat32Arrays(sampleChunksRef.current);
      const sampleRate = audioContext?.sampleRate || 44100;
      const duration = fullSamples.length / sampleRate;
      const rawBlob = buildWavBlob(fullSamples, sampleRate);

      const [denoisedSamples, opusSamples] = await Promise.all([
        processAudioSamples(fullSamples, settings.denoiseStrength, settings.denoiseFrameSize, 'denoise'),
        processAudioSamples(fullSamples, settings.opusBitrate / 64000, settings.denoiseFrameSize, 'compress'),
      ]);

      const denoisedBlob = buildWavBlob(denoisedSamples, sampleRate);
      const opusBlob = buildWavBlob(opusSamples, sampleRate);

      const createTrack = (label, blob, kind) => ({
        id: `${label}-${Date.now()}`,
        label,
        kind,
        blob,
        url: URL.createObjectURL(blob),
        size: blob.size,
        duration: duration,
      });

      tracks.forEach((track) => URL.revokeObjectURL(track.url));
      setTracks([
        createTrack('Raw', rawBlob, 'raw'),
        createTrack('Denoised', denoisedBlob, 'denoised'),
        createTrack('Opus', opusBlob, 'opus'),
      ]);
    } catch (err) {
      setError(err.message || 'Recording could not be processed.');
    } finally {
      setIsRecording(false);
      setIsProcessing(false);
      setLevel(0);
      mediaRecorderRef.current = null;
      processorRef.current = null;
      audioContextRef.current = null;
      streamRef.current = null;
      noiseSuppressorNodeRef.current = null;
      sampleChunksRef.current = [];
    }
  };

  const handleSettingChange = (event) => {
    const { name, value } = event.target;
    setSettings((current) => ({
      ...current,
      [name]: name === 'opusBitrate' ? Number(value) : Number(value),
    }));
  };

  const summary = useMemo(() => {
    return tracks.length
      ? `${tracks.length} tracks ready · ${tracks[0].duration.toFixed(2)}s max duration`
      : 'No audio captured yet';
  }, [tracks]);

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">React Audio Recorder</p>
          <h1>Capture, inspect, and compare audio takes</h1>
          <p className="hero-copy">
            Record from the microphone, review the waveform level, and listen to raw, denoised, and Opus-style variants.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary" onClick={startRecording} disabled={isRecording || isProcessing}>
            {isRecording ? 'Recording…' : 'Record'}
          </button>
          <button className="secondary" onClick={stopRecording} disabled={!isRecording || isProcessing}>
            {isProcessing ? 'Processing…' : 'Stop'}
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <h2>Library controls</h2>
          <span className="badge">{summary}</span>
        </div>
        <div className="settings-grid">
          <label>
            <span>Denoise strength</span>
            <input type="range" min="0.2" max="0.95" step="0.05" name="denoiseStrength" value={settings.denoiseStrength} onChange={handleSettingChange} />
            <strong>{settings.denoiseStrength.toFixed(2)}</strong>
          </label>
          <label>
            <span>Denoise frame size</span>
            <input type="range" min="64" max="512" step="64" name="denoiseFrameSize" value={settings.denoiseFrameSize} onChange={handleSettingChange} />
            <strong>{settings.denoiseFrameSize}</strong>
          </label>
          <label>
            <span>Opus bitrate</span>
            <input type="range" min="16000" max="64000" step="8000" name="opusBitrate" value={settings.opusBitrate} onChange={handleSettingChange} />
            <strong>{settings.opusBitrate}</strong>
          </label>
        </div>
      </section>

      <section className="panel stats-grid">
        <div>
          <h2>Live capture</h2>
          <p className="stat">Timer: {formatDuration(elapsedTime)}</p>
          <p className="stat">Signal level: {(level * 100).toFixed(0)}%</p>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${Math.min(level * 100, 100)}%` }} />
          </div>
        </div>
        <div>
          <h2>Notes</h2>
          <ul>
            <li>Recording starts from a user tap/click to satisfy browser audio requirements.</li>
            <li>Playback uses WAV-compatible blobs for broad browser support.</li>
            <li>Processing is implemented with a browser-safe fallback path when WASM modules are unavailable.</li>
          </ul>
        </div>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="tracks-grid">
        {tracks.map((track) => (
          <article className="track-card" key={track.id}>
            <div className="track-heading">
              <h3>{track.label}</h3>
              <span>{formatBytes(track.size)}</span>
            </div>
            <p>{formatDuration(track.duration)}</p>
            <audio controls src={track.url} />
            <a className="download-link" href={track.url} download={`${track.kind}.wav`}>
              Download WAV
            </a>
          </article>
        ))}
      </section>
    </div>
  );
}

function mergeFloat32Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let cursor = 0;

  chunks.forEach((chunk) => {
    output.set(chunk, cursor);
    cursor += chunk.length;
  });

  return output;
}

export default App;
