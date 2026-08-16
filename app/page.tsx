"use client";

import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

type Source = "upload" | "youtube" | "soundcloud" | "spotify";

type Track = {
  id: string;
  title: string;
  artist: string;
  source: Source;
  sourceUrl?: string;
  fileName?: string;
  buffer?: AudioBuffer;
  duration: number;
  energy: number;
  status: "mix-ready" | "reference-only";
};

type MixTrack = Track & {
  start: number;
  end: number;
  transitionAfter: number;
};

type Mix = {
  title: string;
  tracks: MixTrack[];
  duration: number;
  references: Track[];
};

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00";

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds
  ).padStart(2, "0")}`;
}

function sourceLabel(source: Source) {
  if (source === "youtube") return "YouTube";
  if (source === "soundcloud") return "SoundCloud";
  if (source === "spotify") return "Spotify";
  return "Upload";
}

function sourceClass(source: Source) {
  return `source-${source}`;
}

function energyLabel(value: number) {
  if (value < 0.35) return "Low energy";
  if (value < 0.65) return "Medium energy";
  return "High energy";
}

function parseFileName(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const parts = withoutExtension.split(" - ");

  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(" - ").trim()
    };
  }

  return {
    artist: "Uploaded artist",
    title: withoutExtension.trim()
  };
}

function estimateEnergy(buffer: AudioBuffer) {
  const channel = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(channel.length / 50000));

  let total = 0;
  let count = 0;

  for (let index = 0; index < channel.length; index += step) {
    total += channel[index] * channel[index];
    count += 1;
  }

  const rms = Math.sqrt(total / Math.max(count, 1));

  return Math.max(0.08, Math.min(1, rms * 3.5));
}

function detectSource(url: string): Source | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      return "youtube";
    }

    if (host.includes("soundcloud.com")) {
      return "soundcloud";
    }

    if (host.includes("spotify.com")) {
      return "spotify";
    }

    return null;
  } catch {
    return null;
  }
}

function titleFromUrl(url: string, source: Source) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname)
      .replace(/\/(playlist|track|sets|album)\//g, "")
      .replace(/\//g, " ")
      .trim();

    if (path) {
      return path
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  } catch {
    // Use the fallback title below.
  }

  return `${sourceLabel(source)} reference`;
}

export default function HomePage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [linkValue, setLinkValue] = useState("");
  const [mix, setMix] = useState<Mix | null>(null);
  const [view, setView] = useState<"import" | "player">("import");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");

  const audioContextRef = useRef<AudioContext | null>(null);

  function getAudioContext() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    return audioContextRef.current;
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);

    if (!files.length) return;

    setError("");
    setIsAnalyzing(true);

    try {
      const context = getAudioContext();
      const decodedTracks: Track[] = [];

      for (const file of files) {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = await context.decodeAudioData(arrayBuffer);
        const parsedName = parseFileName(file.name);

        decodedTracks.push({
          id: createId(),
          title: parsedName.title,
          artist: parsedName.artist,
          source: "upload",
          fileName: file.name,
          buffer,
          duration: buffer.duration,
          energy: estimateEnergy(buffer),
          status: "mix-ready"
        });
      }

      setTracks((current) => [...current, ...decodedTracks]);
    } catch {
      setError(
        "One or more files could not be decoded. Try MP3, WAV, M4A, or FLAC files."
      );
    } finally {
      setIsAnalyzing(false);
      event.target.value = "";
    }
  }

  function addLink() {
    const source = detectSource(linkValue.trim());

    if (!source) {
      setError(
        "Paste a valid YouTube, SoundCloud, or Spotify song or playlist link."
      );
      return;
    }

    const referenceTrack: Track = {
      id: createId(),
      title: titleFromUrl(linkValue.trim(), source),
      artist: "Linked source",
      source,
      sourceUrl: linkValue.trim(),
      duration: 0,
      energy: 0,
      status: "reference-only"
    };

    setTracks((current) => [...current, referenceTrack]);
    setLinkValue("");
    setError("");
  }

  function removeTrack(id: string) {
    setTracks((current) => current.filter((track) => track.id !== id));
  }

  function generateMix() {
    const playableTracks = tracks.filter(
      (track) => track.status === "mix-ready" && track.buffer
    );

    if (!playableTracks.length) {
      setError(
        "Upload at least one audio file before generating a playable mix."
      );
      return;
    }

    setError("");

    /*
      Simple first-pass sequencing:
      lower-energy songs open the mix and higher-energy songs build toward
      a stronger middle or ending.
    */
    const orderedTracks = [...playableTracks].sort(
      (first, second) => first.energy - second.energy
    );

    let cursor = 0;

    const generatedTracks: MixTrack[] = orderedTracks.map((track, index) => {
      const nextTrack = orderedTracks[index + 1];

      const transitionAfter = nextTrack
        ? Math.min(8, track.duration * 0.18, nextTrack.duration * 0.18)
        : 0;

      const start = cursor;
      const end = start + track.duration;

      cursor = end - transitionAfter;

      return {
        ...track,
        start,
        end,
        transitionAfter
      };
    });

    const totalDuration =
      generatedTracks[generatedTracks.length - 1]?.end || 0;

    const references = tracks.filter(
      (track) => track.status === "reference-only"
    );

    setMix({
      title: "Untitled Continuum",
      tracks: generatedTracks,
      duration: totalDuration,
      references
    });

    setView("player");
  }

  const playableCount = useMemo(
    () => tracks.filter((track) => track.status === "mix-ready").length,
    [tracks]
  );

  const referenceCount = useMemo(
    () => tracks.filter((track) => track.status === "reference-only").length,
    [tracks]
  );

  if (view === "player" && mix) {
    return (
      <MixPlayer
        mix={mix}
        audioContext={getAudioContext()}
        onBack={() => setView("import")}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◒</span>
          <span>continuum</span>
        </div>

        <span className="topbar-caption">Personal continuous mixes</span>
      </header>

      <section className="import-hero">
        <div className="eyebrow">YOUR MUSIC, MIXED LIKE SOMEONE CARED</div>

        <h1>
          Turn a collection of songs into a continuous listening experience.
        </h1>

        <p className="hero-copy">
          Add audio files or link music from your favorite platforms. Continuum
          creates a playable mix with an intentional order and fluid
          transitions.
        </p>
      </section>

      <section className="import-layout">
        <div className="import-column">
          <div className="panel upload-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">STEP 01</div>
                <h2>Add music</h2>
              </div>

              <span className="track-counter">
                {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
              </span>
            </div>

            <label className="upload-zone">
              <input
                type="file"
                accept="audio/*"
                multiple
                onChange={handleFiles}
              />

              <span className="upload-icon">↑</span>
              <strong>Upload audio files</strong>
              <span>MP3, WAV, M4A, or FLAC</span>
              <span className="upload-button">Choose files</span>
            </label>

            <div className="divider">
              <span>or link a source</span>
            </div>

            <div className="link-form">
              <input
                value={linkValue}
                onChange={(event) => setLinkValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addLink();
                }}
                placeholder="YouTube, SoundCloud, or Spotify link"
                aria-label="Music source link"
              />

              <button className="secondary-button" onClick={addLink}>
                Add link
              </button>
            </div>

            <p className="helper-text">
              Linked tracks are saved as references. Uploaded or otherwise
              authorized audio is required for the rendered mix.
            </p>
          </div>

          {error && <div className="error-message">{error}</div>}

          {isAnalyzing && (
            <div className="analysis-card">
              <span className="spinner" />
              <div>
                <strong>Analyzing your audio…</strong>
                <span>Measuring energy and preparing the mix.</span>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">STEP 02</div>
                <h2>Your source material</h2>
              </div>
            </div>

            {!tracks.length ? (
              <div className="empty-state">
                <div className="empty-symbol">♫</div>
                <strong>Your mix starts here.</strong>
                <span>
                  Upload a few songs or add a playlist link to begin.
                </span>
              </div>
            ) : (
              <div className="source-list">
                {tracks.map((track, index) => (
                  <div className="source-row" key={track.id}>
                    <div className="source-number">
                      {String(index + 1).padStart(2, "0")}
                    </div>

                    <div className="source-details">
                      <strong>{track.title}</strong>
                      <span>
                        {track.artist}
                        {track.duration > 0 &&
                          ` · ${formatTime(track.duration)}`}
                      </span>
                    </div>

                    <span
                      className={`source-badge ${sourceClass(track.source)}`}
                    >
                      {sourceLabel(track.source)}
                    </span>

                    <span
                      className={`status-badge ${
                        track.status === "mix-ready"
                          ? "status-ready"
                          : "status-reference"
                      }`}
                    >
                      {track.status === "mix-ready"
                        ? "Mix-ready"
                        : "Reference"}
                    </span>

                    <button
                      className="remove-button"
                      onClick={() => removeTrack(track.id)}
                      aria-label={`Remove ${track.title}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="generate-card">
          <div className="generate-glow" />

          <div className="eyebrow">STEP 03</div>
          <h2>Generate the experience.</h2>

          <p>
            Continuum will arrange your mix from lower to higher energy, then
            create overlapping transitions between every playable song.
          </p>

          <div className="mix-stat-row">
            <div>
              <strong>{playableCount}</strong>
              <span>ready to mix</span>
            </div>

            <div>
              <strong>{referenceCount}</strong>
              <span>references</span>
            </div>
          </div>

          <button
            className="primary-button generate-button"
            onClick={generateMix}
            disabled={isAnalyzing || playableCount === 0}
          >
            Generate Mix
            <span>→</span>
          </button>

          <div className="generate-note">
            <span className="note-dot" />
            The result will open in a dedicated mix player.
          </div>
        </aside>
      </section>

      <footer className="app-footer">
        <span>continuum</span>
        <span>Build a beginning, middle, and ending.</span>
      </footer>
    </main>
  );
}

function Visualizer({
  analyser,
  playing
}: {
  analyser: AnalyserNode | null;
  playing: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) return;

    const context = canvas.getContext("2d");

    if (!context) return;

    let animationFrame = 0;
    const pixelRatio = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = canvas.clientWidth * pixelRatio;
      canvas.height = canvas.clientHeight * pixelRatio;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    resize();
    window.addEventListener("resize", resize);

    const frequencyData = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;

    function draw() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      context.clearRect(0, 0, width, height);

      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#17113d");
      gradient.addColorStop(0.5, "#39206e");
      gradient.addColorStop(1, "#071d35");

      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      if (frequencyData && analyser) {
        analyser.getByteFrequencyData(frequencyData);
      }

      const barCount = 70;
      const barWidth = width / barCount;

      for (let index = 0; index < barCount; index += 1) {
        const dataIndex = frequencyData
          ? Math.floor((index / barCount) * frequencyData.length)
          : 0;

        const rawValue = frequencyData
          ? frequencyData[dataIndex] / 255
          : 0.15 + Math.sin(Date.now() / 800 + index / 3) * 0.06;

        const value = playing ? rawValue : rawValue * 0.45;
        const barHeight = Math.max(3, value * height * 0.75);

        const barGradient = context.createLinearGradient(
          0,
          height - barHeight,
          0,
          height
        );

        barGradient.addColorStop(0, "#e7b8ff");
        barGradient.addColorStop(1, "#63d9ff");

        context.fillStyle = barGradient;
        context.fillRect(
          index * barWidth,
          height - barHeight,
          Math.max(2, barWidth - 3),
          barHeight
        );
      }

      animationFrame = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
    };
  }, [analyser, playing]);

  return <canvas className="visualizer-canvas" ref={canvasRef} />;
}

function MixPlayer({
  mix,
  audioContext,
  onBack
}: {
  mix: Mix;
  audioContext: AudioContext;
  onBack: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const masterGainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const currentTimeRef = useRef(0);
  const anchorRef = useRef({
    contextTime: 0,
    mixOffset: 0
  });

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    return () => {
      for (const source of sourcesRef.current) {
        try {
          source.stop();
        } catch {
          // The source may already have stopped.
        }

        source.disconnect();
      }

      sourcesRef.current = [];
    };
  }, []);

  function prepareAudioGraph() {
    if (masterGainRef.current) {
      return;
    }

    const masterGain = audioContext.createGain();
    const audioAnalyser = audioContext.createAnalyser();

    audioAnalyser.fftSize = 256;
    masterGain.gain.value = 0.88;

    masterGain.connect(audioAnalyser);
    audioAnalyser.connect(audioContext.destination);

    masterGainRef.current = masterGain;
    setAnalyser(audioAnalyser);
  }

  function stopSources() {
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        // The source may already have stopped.
      }

      source.disconnect();
    }

    sourcesRef.current = [];
  }

  function calculateGain(track: MixTrack, index: number, offset: number) {
    let gain = 1;

    if (index > 0 && track.transitionAfter > 0) {
      const fadeInEnd = track.start + track.transitionAfter;

      if (offset < fadeInEnd) {
        gain = Math.min(
          gain,
          Math.max(0, (offset - track.start) / track.transitionAfter)
        );
      }
    }

    if (
      index < mix.tracks.length - 1 &&
      track.transitionAfter > 0 &&
      offset > track.end - track.transitionAfter
    ) {
      gain = Math.min(
        gain,
        Math.max(0, (track.end - offset) / track.transitionAfter)
      );
    }

    return Math.max(0, Math.min(1, gain));
  }

  function scheduleFrom(offset: number) {
    prepareAudioGraph();
    stopSources();

    const masterGain = masterGainRef.current;

    if (!masterGain) return;

    const now = audioContext.currentTime + 0.05;

    anchorRef.current = {
      contextTime: now,
      mixOffset: offset
    };

    mix.tracks.forEach((track, index) => {
      if (!track.buffer || track.end <= offset) return;

      const source = audioContext.createBufferSource();
      const gainNode = audioContext.createGain();
      const sourceStart =
        offset < track.start ? now + track.start - offset : now;
      const sourceOffset = Math.max(0, offset - track.start);

      source.buffer = track.buffer;
      source.connect(gainNode);
      gainNode.connect(masterGain);

      const initialGain =
        offset >= track.start
          ? calculateGain(track, index, offset)
          : 0;

      gainNode.gain.setValueAtTime(initialGain, now);

      if (offset < track.start) {
        gainNode.gain.setValueAtTime(0, now);
      }

      if (index > 0 && track.transitionAfter > 0) {
        const fadeInEnd = track.start + track.transitionAfter;

        if (offset < fadeInEnd) {
          gainNode.gain.linearRampToValueAtTime(
            1,
            now + Math.max(0, fadeInEnd - offset)
          );
        }
      }

      if (index < mix.tracks.length - 1 && track.transitionAfter > 0) {
        const fadeOutStart = track.end - track.transitionAfter;

        if (offset < fadeOutStart) {
          gainNode.gain.setValueAtTime(
            1,
            now + Math.max(0, fadeOutStart - offset)
          );
        }

        if (offset < track.end) {
          gainNode.gain.linearRampToValueAtTime(
            0,
            now + Math.max(0, track.end - offset)
          );
        }
      }

      source.start(sourceStart, sourceOffset);
      sourcesRef.current.push(source);
    });
  }

  async function togglePlayback() {
    prepareAudioGraph();

    if (playing) {
      const pausedAt = currentTimeRef.current;

      stopSources();
      setPlaying(false);
      setCurrentTime(pausedAt);
      currentTimeRef.current = pausedAt;

      return;
    }

    await audioContext.resume();

    const startOffset =
      currentTimeRef.current >= mix.duration
        ? 0
        : currentTimeRef.current;

    scheduleFrom(startOffset);
    setPlaying(true);
  }

  function seekTo(value: number) {
    const nextTime = Math.max(0, Math.min(mix.duration, value));

    currentTimeRef.current = nextTime;
    setCurrentTime(nextTime);

    if (playing) {
      scheduleFrom(nextTime);
    }
  }

  useEffect(() => {
    if (!playing) return;

    let animationFrame = 0;

    function updateTime() {
      const elapsed =
        audioContext.currentTime - anchorRef.current.contextTime;

      const nextTime = anchorRef.current.mixOffset + elapsed;

      if (nextTime >= mix.duration) {
        stopSources();
        currentTimeRef.current = mix.duration;
        setCurrentTime(mix.duration);
        setPlaying(false);
        return;
      }

      currentTimeRef.current = nextTime;
      setCurrentTime(nextTime);
      animationFrame = requestAnimationFrame(updateTime);
    }

    animationFrame = requestAnimationFrame(updateTime);

    return () => cancelAnimationFrame(animationFrame);
  }, [playing, audioContext, mix.duration]);

  const activeTrackIndex = mix.tracks.findIndex(
    (track) => currentTime >= track.start && currentTime < track.end
  );

  return (
    <main className="player-shell">
      <header className="player-topbar">
        <button className="back-button" onClick={onBack}>
          ← <span>Back to library</span>
        </button>

        <div className="brand">
          <span className="brand-mark">◒</span>
          <span>continuum</span>
        </div>

        <div className="player-actions">
          <button className="quiet-button">Save</button>
          <button className="quiet-button">Share</button>
        </div>
      </header>

      <section className="mix-visual">
        <Visualizer analyser={analyser} playing={playing} />

        <div className="visual-overlay">
          <div className="eyebrow">GENERATED MIX</div>

          <h1>{mix.title}</h1>

          <p>
            {formatTime(mix.duration)} · {mix.tracks.length} songs ·{" "}
            {Math.max(0, mix.tracks.length - 1)} transitions
          </p>
        </div>
      </section>

      <section className="player-controls">
        <div className="progress-row">
          <span>{formatTime(currentTime)}</span>

          <input
            className="progress-slider"
            type="range"
            min="0"
            max={mix.duration}
            step="0.1"
            value={currentTime}
            onChange={(event) => seekTo(Number(event.target.value))}
            aria-label="Mix progress"
          />

          <span>{formatTime(mix.duration)}</span>
        </div>

        <div className="control-row">
          <button
            className="transport-button"
            onClick={() => seekTo(Math.max(0, currentTime - 15))}
            aria-label="Back fifteen seconds"
          >
            ↶
          </button>

          <button
            className="main-play-button"
            onClick={togglePlayback}
            aria-label={playing ? "Pause mix" : "Play mix"}
          >
            {playing ? "Ⅱ" : "▶"}
          </button>

          <button
            className="transport-button"
            onClick={() =>
              seekTo(Math.min(mix.duration, currentTime + 15))
            }
            aria-label="Forward fifteen seconds"
          >
            ↷
          </button>
        </div>
      </section>

      <section className="track-order-section">
        <div className="track-order-heading">
          <div>
            <div className="eyebrow">THE JOURNEY</div>
            <h2>Tracks in mix order</h2>
          </div>

          <span>{mix.tracks.length} songs</span>
        </div>

        <div className="mix-track-list">
          {mix.tracks.map((track, index) => {
            const isActive = index === activeTrackIndex;

            return (
              <div key={track.id}>
                {index > 0 && (
                  <div className="transition-marker">
                    <span className="transition-line" />
                    <span>
                      {track.transitionAfter > 0
                        ? `${Math.round(
                            mix.tracks[index - 1].transitionAfter * 4
                          )}-beat blend`
                        : "Seamless transition"}
                    </span>
                    <span className="transition-line" />
                  </div>
                )}

                <button
                  className={`mix-track-row ${
                    isActive ? "mix-track-active" : ""
                  }`}
                  onClick={() => seekTo(track.start)}
                >
                  <span className="mix-track-number">
                    {isActive ? "♫" : String(index + 1).padStart(2, "0")}
                  </span>

                  <span className="mix-track-main">
                    <strong>{track.title}</strong>
                    <span>{track.artist}</span>
                  </span>

                  <span className="mix-track-meta">
                    <span>{energyLabel(track.energy)}</span>
                    <span>{formatTime(track.start)}</span>
                  </span>

                  <span className="mix-track-arrow">→</span>
                </button>
              </div>
            );
          })}
        </div>

        {mix.references.length > 0 && (
          <div className="references-note">
            <strong>{mix.references.length} linked reference tracks</strong>
            <span>
              These tracks were kept as source references and were not included
              in the rendered audio.
            </span>
          </div>
        )}
      </section>

      <footer className="app-footer player-footer">
        <span>continuum</span>
        <span>A finished listening experience.</span>
      </footer>
    </main>
  );
}
