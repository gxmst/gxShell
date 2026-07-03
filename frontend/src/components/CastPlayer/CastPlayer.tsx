import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { types } from "../../../wailsjs/go/models";
import { ReadRecording } from "../../../wailsjs/go/main/App";
import { getTerminalTheme } from "../../utils/format";
import { t } from "../../i18n";

// A parsed .cast v2 event: [relativeSeconds, code, data]. code "o" = output,
// "r" = resize (data is "COLSxROWS").
type CastEvent = { time: number; code: string; data: string };
type CastHeader = { width: number; height: number; title?: string };

// parseCast reads asciinema v2 JSON Lines: a header object on line 1, then one
// JSON array per event. Malformed lines are skipped so a truncated recording
// (e.g. app killed mid-session) still plays what it captured.
function parseCast(text: string): { header: CastHeader; events: CastEvent[] } {
  const lines = text.split("\n");
  let header: CastHeader = { width: 80, height: 24 };
  const events: CastEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0) {
      try {
        const parsed = JSON.parse(line);
        header = { width: parsed.width || 80, height: parsed.height || 24, title: parsed.title };
      } catch {
        // ignore a bad header; defaults are fine
      }
      continue;
    }
    try {
      const arr = JSON.parse(line);
      if (Array.isArray(arr) && arr.length >= 3) {
        events.push({ time: Number(arr[0]) || 0, code: String(arr[1]), data: String(arr[2]) });
      }
    } catch {
      // skip malformed event line
    }
  }
  return { header, events };
}

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

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);

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

    if (idxRef.current >= events.length) {
      setPlaying(false);
      setElapsed(duration);
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
    const playedSeconds = idxRef.current > 0 ? events[idxRef.current - 1].time : 0;
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
    setPlaying(false);
  }, []);

  // Load the recording and build the xterm instance once.
  useEffect(() => {
    let disposed = false;
    ReadRecording(name).then((content) => {
      if (disposed) return;
      const { header, events } = parseCast(content);
      eventsRef.current = events;
      setDuration(events.length ? events[events.length - 1].time : 0);
      const host = hostRef.current;
      if (!host) return;
      const term = new Terminal({
        allowProposedApi: true,
        convertEol: true,
        fontFamily: settings?.terminal.fontFamily || "JetBrains Mono, Cascadia Code, Consolas, monospace",
        fontSize: settings?.terminal.fontSize || 13.5,
        lineHeight: settings?.terminal.lineHeight || 1.35,
        cols: header.width,
        rows: header.height,
        scrollback: 5000,
        theme: settings ? getTerminalTheme(settings) : undefined,
        disableStdin: true,
        cursorBlink: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
      if (!events.length) setError(t(locale, "recordingEmpty"));
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
    term.options.fontSize = settings.terminal.fontSize;
    term.options.lineHeight = settings.terminal.lineHeight;
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

  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="cast-player" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cast-player-header">
          <span className="cast-player-title" title={name}>{name}</span>
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
          <div className="cast-progress">
            <div className="cast-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="cast-time">{fmt(elapsed)} / {fmt(duration)}</span>
          <button className="cast-speed" onClick={cycleSpeed} title={t(locale, "playbackSpeed")}>{speed}x</button>
        </div>
      </div>
    </div>
  );
}
