import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { CastScreen } from "./castScreen";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { types } from "../../../wailsjs/go/models";
import { ReadRecording } from "../../../wailsjs/go/app/App";
import { getTerminalContrastRatio, getTerminalTheme } from "../../utils/format";
import { normalizeFontSize, normalizeLineHeight } from "../../utils/terminalSettings";
import { t } from "../../i18n";
import { parseCast, type CastEvent } from "./castParser";

const SPEEDS = [1, 2, 4, 8];

export function CastPlayer({ name, settings, locale, onClose }: { name: string; settings: types.AppSettings | null; locale: string; onClose: () => void }) {
  const playerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    playerRef.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const screenRef = useRef<CastScreen | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<CastEvent[]>([]);
  const timerRef = useRef<number | null>(null);
  const idxRef = useRef(0);
  // Wall-clock anchor: the play-time that maps to playhead 0, adjusted for speed.
  const anchorRef = useRef(0);
  const speedRef = useRef(1);
  const elapsedRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState(name);

  speedRef.current = speed;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Schedule the next frame relative to the wall clock so playback keeps real
  // timing regardless of render cadence. Each step writes all events whose
  // timestamp has passed, then arms a timer for the next one.
  const step = useCallback(() => {
    const term = termRef.current;
    const events = eventsRef.current;
    if (!term) return;
    const speedFactor = speedRef.current;
    const now = performance.now();
    const playhead = ((now - anchorRef.current) / 1000) * speedFactor;

    while (idxRef.current < events.length && events[idxRef.current].time <= playhead) {
      idxRef.current += 1;
    }
    screenRef.current?.show(idxRef.current);
    setElapsed(Math.min(playhead, duration));
    elapsedRef.current = Math.min(playhead, duration);

    if (idxRef.current >= events.length) {
      setPlaying(false);
      setElapsed(duration);
      elapsedRef.current = duration;
      return;
    }
    const nextAt = events[idxRef.current].time;
    const waitMs = Math.max(0, ((nextAt - playhead) / speedFactor) * 1000);
    timerRef.current = window.setTimeout(step, Math.min(150, waitMs));
  }, [duration]);

  const pause = useCallback(() => {
    clearTimer();
    if (playing) {
      elapsedRef.current = Math.min(duration, (performance.now() - anchorRef.current) / 1000 * speedRef.current);
      setElapsed(elapsedRef.current);
    }
    setPlaying(false);
  }, [duration, playing]);

  const play = useCallback(() => {
    const events = eventsRef.current;
    if (!events.length) return;
    if (idxRef.current >= events.length) {
      // Restart from the beginning if we're at the end.
      screenRef.current?.show(0, true);
      idxRef.current = 0;
      elapsedRef.current = 0;
      setElapsed(0);
    }
    const playedSeconds = elapsedRef.current;
    anchorRef.current = performance.now() - (playedSeconds / speedRef.current) * 1000;
    setPlaying(true);
    clearTimer();
    step();
  }, [step]);

  const restart = useCallback(() => {
    clearTimer();
    screenRef.current?.show(0, true);
    idxRef.current = 0;
    setElapsed(0);
    elapsedRef.current = 0;
    setPlaying(false);
  }, []);

  const seekTo = useCallback((requested: number) => {
    const term = termRef.current;
    if (!term) return;
    const events = eventsRef.current;
    const target = Math.max(0, Math.min(duration, requested));
    clearTimer();
    setPlaying(false);
    let index = 0;
    while (index < events.length && events[index].time <= target) index++;
    screenRef.current?.show(index, true);
    idxRef.current = index;
    elapsedRef.current = target;
    setElapsed(target);
  }, [duration]);

  // Load the recording and build the xterm instance once.
  useEffect(() => {
    let disposed = false;
    ReadRecording(name).then((content) => {
      if (disposed) return;
      const { header, events, truncated } = parseCast(content);
      eventsRef.current = events;
      setTitle(header.title || name);
      setDuration(events.length ? events[events.length - 1].time : 0);
      const host = hostRef.current;
      if (!host) return;
      const term = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        fontFamily: settings?.terminal.fontFamily || "JetBrains Mono, Cascadia Code, Consolas, monospace",
        fontSize: normalizeFontSize(settings?.terminal.fontSize),
        lineHeight: normalizeLineHeight(settings?.terminal.lineHeight),
        cols: header.width,
        rows: header.height,
        scrollback: 0,
        theme: settings ? getTerminalTheme(settings) : undefined,
        minimumContrastRatio: settings ? getTerminalContrastRatio(settings) : 1,
        disableStdin: true,
        cursorBlink: false,
      });
      try {
        term.open(host);
      } catch (openError) {
        term.dispose();
        setError(String(openError));
        return;
      }
      termRef.current = term;
      screenRef.current = new CastScreen(term, header, events);
      setReady(true);
      if (!events.length) setError(t(locale, "recordingEmpty"));
      else if (truncated) setError(t(locale, "recordingTooManyEvents"));
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      clearTimer();
      screenRef.current?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const screen = host?.querySelector<HTMLElement>(".xterm-screen");
    if (!host || !stage || !screen || !ready) return;
    const resize = () => {
      const width = screen.offsetWidth, height = screen.offsetHeight;
      if (!width || !height) return;
      const scale = Math.min(1, stage.clientWidth / width, stage.clientHeight / height);
      host.style.width = width + "px";
      host.style.height = height + "px";
      host.style.setProperty("--cast-scale", String(scale));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    observer.observe(screen);
    resize();
    return () => observer.disconnect();
  }, [ready]);

  // Auto-play once ready.
  useEffect(() => {
    if (ready && eventsRef.current.length) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Apply theme/font live when settings arrive or change. The terminal is built
  // once (keyed on name) so it never tears down mid-playback; this effect keeps
  // its appearance in sync when settings load after the terminal was created.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.theme = getTerminalTheme(settings);
    term.options.minimumContrastRatio = getTerminalContrastRatio(settings);
    term.options.fontFamily = settings.terminal.fontFamily;
    term.options.fontSize = normalizeFontSize(settings.terminal.fontSize);
    term.options.lineHeight = normalizeLineHeight(settings.terminal.lineHeight);
  }, [settings, ready]);

  const fmt = (s: number) => {
    const total = Math.floor(s);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    // The anchor maps wall-clock time to playhead at the *old* speed, so
    // changing speed without re-anchoring moves the playhead: going 1x -> 2x
    // doubles the elapsed position and skips that much recorded content. While
    // playing, re-anchor at the current position under the new speed; while
    // paused, play() builds the anchor when playback resumes.
    if (playing) {
      const now = performance.now();
      elapsedRef.current = Math.min(duration, (now - anchorRef.current) / 1000 * speedRef.current);
      anchorRef.current = now - (elapsedRef.current / next) * 1000;
    }
    // Set the ref directly too: step() may fire from its timer before React
    // re-renders, and it would then pair the new anchor with the old speed.
    speedRef.current = next;
    setSpeed(next);
  };

  return (
    <section ref={playerRef} tabIndex={-1} className="cast-player" aria-label={t(locale, "recordings")} onKeyDown={event => {
      if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "w")) {
        event.preventDefault(); event.stopPropagation(); onClose();
      } else if (event.key === " " && event.target === event.currentTarget) {
        event.preventDefault();
        if (playing) pause(); else play();
      }
    }}>
      <div className="cast-player-header">
        <span className="cast-player-title" title={name}>{title}</span>
        <button className="mini-btn" onClick={onClose} title={t(locale, "close")}><X size={13} /></button>
      </div>
      <div ref={stageRef} className="cast-player-stage">
        <div ref={hostRef} className="cast-player-term" />
        {error && <div className="cast-player-error">{error}</div>}
      </div>
      <div className="cast-player-controls">
        <button className="mini-btn" onClick={playing ? pause : play} title={t(locale, playing ? "pause" : "play")}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="mini-btn" onClick={restart} title={t(locale, "restart")}><RotateCcw size={13} /></button>
        <input
          className="cast-progress cast-progress-input"
          type="range"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.1}
          value={Math.min(elapsed, Math.max(duration, 0.01))}
          onPointerDown={pause}
          onChange={(event) => { const value = Number(event.target.value); elapsedRef.current = value; setElapsed(value); }}
          onPointerUp={(event) => seekTo(Number(event.currentTarget.value))}
          onKeyUp={(event) => seekTo(Number(event.currentTarget.value))}
          aria-label={t(locale, "playbackPosition")}
        />
        <span className="cast-time">{fmt(elapsed)} / {fmt(duration)}</span>
        <button className="cast-speed" onClick={cycleSpeed} title={t(locale, "playbackSpeed")}>{speed}x</button>
      </div>
    </section>
  );
}
