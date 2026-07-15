import { useEffect, useMemo, useRef, useState } from 'react';
import { buildOpusBlob, buildWavBlob, formatBytes, formatDuration, processAudioSamples } from './audio';

const INITIAL_SETTINGS = {
  denoiseStrength: 0.7,
  denoiseFrameSize: 128,
  rnnoiseEnabled: true,
  opusBitrate: 32000,
  opusFrameSize: 960,
  opusApplication: 'Voip',
  opusSignal: 'Voice',
  opusComplexity: 10,
  opusPacketLossPercent: 0,
  opusVbr: true,
  opusVbrConstraint: false,
  includeRaw: true,
  includeDenoised: true,
  includeOpus: true,
  includeDenoisedOpus: true,
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
        //   noiseSuppression: true,
        //   autoGainControl: true,
        },
      });
      const audioContext = new window.AudioContext();
      await audioContext.resume();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        output.set(input);

        const peak = input.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        setLevel(peak);
        sampleChunksRef.current.push(new Float32Array(input));
      };

      sourceNode.connect(processor);
      processor.connect(audioContext.destination);

      streamRef.current = stream;
      mediaRecorderRef.current = { stream, audioContext, sourceNode, processor };
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

      const createTrack = (label, blob, kind) => ({
        id: `${label}-${Date.now()}`,
        label,
        kind,
        blob,
        url: URL.createObjectURL(blob),
        size: blob.size,
        duration,
      });

      const newTracks = [];

      if (settings.includeRaw) {
        const rawBlob = buildWavBlob(fullSamples, sampleRate);
        newTracks.push(createTrack('Raw', rawBlob, 'raw'));
      }

      if (settings.includeDenoised || settings.includeDenoisedOpus) {
        const denoisedResult = await processAudioSamples(fullSamples, settings.denoiseStrength, settings.denoiseFrameSize, 'denoise', { ...settings, inputSampleRate: sampleRate });
        if (settings.includeDenoised) {
          const denoisedBlob = buildWavBlob(denoisedResult.samples, denoisedResult.sampleRate);
          newTracks.push(createTrack('Denoised', denoisedBlob, 'denoised'));
        }
        if (settings.includeDenoisedOpus) {
          const denoisedOpusBlob = await buildOpusBlob(denoisedResult.samples, denoisedResult.sampleRate, settings);
          newTracks.push(createTrack('Denoised + Opus', denoisedOpusBlob, 'denoised-opus'));
        }
      }
      if (settings.includeOpus) {
        const opusBlob = await buildOpusBlob(fullSamples, sampleRate, settings);
        newTracks.push(createTrack('Opus', opusBlob, 'opus'));
      }

      tracks.forEach((track) => URL.revokeObjectURL(track.url));
      setTracks(newTracks);
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
      sampleChunksRef.current = [];
    }
  };

  const handleSettingChange = (event) => {
    const { name, value, type, checked } = event.target;
    const parsedValue = type === 'checkbox' ? checked : Number(value);

    setSettings((current) => ({
      ...current,
      [name]: Number.isNaN(parsedValue) ? value : parsedValue,
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
          <h2>Track selection</h2>
          <span className="badge">{summary}</span>
        </div>

        <div className="settings-group">
          <h3>Include tracks</h3>
          <div className="settings-grid">
            <label className="toggle-row">
              <span>Raw</span>
              <input type="checkbox" name="includeRaw" checked={settings.includeRaw} onChange={handleSettingChange} />
            </label>
            <label className="toggle-row">
              <span>Denoised</span>
              <input type="checkbox" name="includeDenoised" checked={settings.includeDenoised} onChange={handleSettingChange} />
            </label>
            <label className="toggle-row">
              <span>Opus</span>
              <input type="checkbox" name="includeOpus" checked={settings.includeOpus} onChange={handleSettingChange} />
            </label>
            <label className="toggle-row">
              <span>Denoised + Opus</span>
              <input type="checkbox" name="includeDenoisedOpus" checked={settings.includeDenoisedOpus} onChange={handleSettingChange} />
            </label>
          </div>
        </div>

        <div className="settings-group">
          <h3>RNNoise</h3>
          <div className="settings-grid">
            <label className="toggle-row">
              <span>Enable RNNoise</span>
              <input type="checkbox" name="rnnoiseEnabled" checked={settings.rnnoiseEnabled} onChange={handleSettingChange} />
            </label>
            <label>
              <span>Strength</span>
              <input type="range" min="0.2" max="0.95" step="0.05" name="denoiseStrength" value={settings.denoiseStrength} onChange={handleSettingChange} />
              <strong>{settings.denoiseStrength.toFixed(2)}</strong>
            </label>
            <label>
              <span>Frame size</span>
              <input type="range" min="64" max="512" step="64" name="denoiseFrameSize" value={settings.denoiseFrameSize} onChange={handleSettingChange} />
              <strong>{settings.denoiseFrameSize}</strong>
            </label>
          </div>
        </div>

        <div className="settings-group">
          <h3>Opus</h3>
          <div className="settings-grid">
            <label>
              <span>Bitrate</span>
              <input type="range" min="16000" max="64000" step="8000" name="opusBitrate" value={settings.opusBitrate} onChange={handleSettingChange} />
              <strong>{settings.opusBitrate}</strong>
            </label>
            <label>
              <span>Frame size</span>
              <input type="range" min="480" max="1920" step="480" name="opusFrameSize" value={settings.opusFrameSize} onChange={handleSettingChange} />
              <strong>{settings.opusFrameSize}</strong>
            </label>
            <label>
              <span>Application</span>
              <select name="opusApplication" value={settings.opusApplication} onChange={handleSettingChange}>
                <option value="Audio">Audio</option>
                <option value="Voip">VoIP</option>
                <option value="RestrictedLowDelay">Low delay</option>
              </select>
            </label>
            <label>
              <span>Signal type</span>
              <select name="opusSignal" value={settings.opusSignal} onChange={handleSettingChange}>
                <option value="Auto">Auto</option>
                <option value="Voice">Voice</option>
                <option value="Music">Music</option>
              </select>
            </label>
            <label>
              <span>Complexity</span>
              <input type="range" min="0" max="10" step="1" name="opusComplexity" value={settings.opusComplexity} onChange={handleSettingChange} />
              <strong>{settings.opusComplexity}</strong>
            </label>
            <label>
              <span>Packet loss %</span>
              <input type="range" min="0" max="100" step="5" name="opusPacketLossPercent" value={settings.opusPacketLossPercent} onChange={handleSettingChange} />
              <strong>{settings.opusPacketLossPercent}%</strong>
            </label>
            <label className="toggle-row">
              <span>VBR</span>
              <input type="checkbox" name="opusVbr" checked={settings.opusVbr} onChange={handleSettingChange} />
            </label>
            <label className="toggle-row">
              <span>VBR constraint</span>
              <input type="checkbox" name="opusVbrConstraint" checked={settings.opusVbrConstraint} onChange={handleSettingChange} />
            </label>
          </div>
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
            <a
              className="download-link"
              href={track.url}
              download={`${track.kind}.${track.kind === 'opus' || track.kind === 'denoised-opus' ? (track.blob.type.includes('webm') ? 'webm' : 'ogg') : 'wav'}`}
            >
              {track.kind === 'opus' || track.kind === 'denoised-opus' ? 'Download Opus' : 'Download WAV'}
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
