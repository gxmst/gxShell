import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { types } from "../../../wailsjs/go/models";
import { ReadRecording } from "../../../wailsjs/go/main/App";
import { getTerminalTheme } from "../../utils/format";
import { normalizeFontSize, normalizeLineHeight } from "../../utils/terminalSettings";
import { t } from "../../i18n";
import { parseCast, type CastEvent } from "./castParser";

const SPEEDS = [1, 2, 4, 8];

export function CastPlayer({ name, settings, locale, onClose }: { name: string; settings: types.AppSettings | null; locale: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
      const ev = events[idxRef.current];
      if (ev.code === "o") term.write(ev.data);
      if (ev.code === "r") {
        const [cols, rows] = ev.data.split("x").map((n) => Number.parseInt(n, 10));
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
          term.resize(cols, rows);
        }
      }
      idxRef.current += 1;
    }
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
    timerRef.current = window.setTimeout(step, waitMs);
  }, [duration]);

  const pause = useCallback(() => {
    clearTimer();
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    const events = eventsRef.current;
    if (!events.length) return;
    if (idxRef.current >= events.length) {
      // Restart from the beginning if we're at the end.
      termRef.current?.reset();
      idxRef.current = 0;
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
    termRef.current?.reset();
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
    term.reset();
    let output = "";
    let index = 0;
    const flush = () => {
      if (output) term.write(output);
      output = "";
    };
    while (index < events.length && events[index].time <= target) {
      const event = events[index];
      if (event.code === "o") {
        output += event.data;
        if (output.length >= 64 * 1024) flush();
      } else if (event.code === "r") {
        flush();
        const [cols, rows] = event.data.split("x").map((value) => Number.parseInt(value, 10));
        if (cols > 0 && rows > 0) term.resize(cols, rows);
      }
      index += 1;
    }
    flush();
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
        scrollback: 5000,
        theme: settings ? getTerminalTheme(settings) : undefined,
        disableStdin: true,
        cursorBlink: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      try {
        term.open(host);
      } catch (openError) {
        term.dispose();
        setError(String(openError));
        return;
      }
      termRef.current = term;
      fitRef.current = fit;
      requestAnimationFrame(() => {
        if (disposed || termRef.current !== term) return;
        try { fit.fit(); } catch {}
        setReady(true);
      });
      if (!events.length) setError(t(locale, "recordingEmpty"));
      else if (truncated) setError(locale === "zh-CN" ? "录制事件过多，内置播放器仅载入前 25 万条。" : "This recording has too many events; the built-in player loaded the first 250,000.");
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      clearTimer();
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit || !ready) return;
    let frame = 0;
    const resize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        try { fit.fit(); } catch {}
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener('resize', resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(frame);
    };
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
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="cast-player" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cast-player-header">
          <span className="cast-player-title" title={name}>{title}</span>
          <button className="mini-btn" onClick={onClose} title={t(locale, "close")}><X size={13} /></button>
        </div>
        <div className="cast-player-stage">
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
            aria-label={locale === "zh-CN" ? "播放进度" : "Playback position"}
          />
          <span className="cast-time">{fmt(elapsed)} / {fmt(duration)}</span>
          <button className="cast-speed" onClick={cycleSpeed} title={t(locale, "playbackSpeed")}>{speed}x</button>
        </div>
      </div>
    </div>
  );
}
