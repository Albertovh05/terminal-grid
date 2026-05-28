import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import type { TerminalSpec } from '../../shared/types';
import { registerTerminal, unregisterTerminal } from './termRegistry';
import { clearActivity, markActivity } from './useActivity';

interface Props {
  spec: TerminalSpec;
  focused: boolean;
  zoomed: boolean;
  fontSize: number;
  fontFamily: string;
  themeMode: 'dark' | 'light';
  onFocus: () => void;
  onClose: () => void;
  onZoom: () => void;
  onRename: (title: string) => void;
  onCwdChanged: (cwd: string) => void;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const darkTheme = {
  background: '#0a0a0c',
  foreground: '#e6e6ec',
  cursor: '#7c5cff',
  cursorAccent: '#0a0a0c',
  selectionBackground: 'rgba(124,92,255,0.35)',
  black: '#1b1b22', red: '#ff5577', green: '#5cf08c', yellow: '#f5d76e',
  blue: '#5c9eff', magenta: '#c780ff', cyan: '#00d4ff', white: '#e6e6ec',
  brightBlack: '#393944', brightRed: '#ff7799', brightGreen: '#8ef0ad',
  brightYellow: '#ffe79c', brightBlue: '#7ab4ff', brightMagenta: '#d49eff',
  brightCyan: '#5ce0ff', brightWhite: '#ffffff',
};
const lightTheme = {
  background: '#fafafa',
  foreground: '#1d1d28',
  cursor: '#6e4cff',
  cursorAccent: '#fafafa',
  selectionBackground: 'rgba(110,76,255,0.20)',
  black: '#1d1d28', red: '#d33754', green: '#2b9050', yellow: '#a17400',
  blue: '#2b6dd2', magenta: '#9148c2', cyan: '#0aa1bf', white: '#5c5c66',
  brightBlack: '#7a7a86', brightRed: '#e1496b', brightGreen: '#37a661',
  brightYellow: '#b48a00', brightBlue: '#4486e5', brightMagenta: '#a85cd1',
  brightCyan: '#21b4d2', brightWhite: '#1d1d28',
};

function safeFit(fit: FitAddon | null): boolean {
  if (!fit) return false;
  try {
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) {
      return false;
    }
    fit.fit();
    return true;
  } catch {
    return false;
  }
}

export function TerminalPane(props: Props) {
  const { spec, focused, zoomed, onFocus, onClose, onZoom, onRename } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const offDataRef = useRef<(() => void) | null>(null);
  const offExitRef = useRef<(() => void) | null>(null);
  const aliveRef = useRef(true);
  const ptySpawnedRef = useRef(false);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(spec.title);
  const [exited, setExited] = useState<{ code: number; signal?: number } | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!editing) setName(spec.title);
  }, [spec.title, editing]);

  const startPty = (term: Terminal, fit: FitAddon) => {
    if (!aliveRef.current || ptySpawnedRef.current) return;
    const ok = safeFit(fit);
    const cols = ok ? term.cols : 80;
    const rows = ok ? term.rows : 24;
    ptySpawnedRef.current = true;
    setExited(null);
    void window.api.pty.create({ id: spec.id, cols, rows, cwd: spec.cwd, shell: spec.shell });
  };

  const restartShell = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.write('\r\n\x1b[2;37m[restarting…]\x1b[0m\r\n');
    ptySpawnedRef.current = false;
    startPty(term, fit);
  };

  useEffect(() => {
    if (!hostRef.current) return;
    aliveRef.current = true;
    const gen = ++generationRef.current;

    const term = new Terminal({
      fontFamily: props.fontFamily,
      fontSize: props.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme: props.themeMode === 'light' ? lightTheme : darkTheme,
      scrollback: 5000,
      cols: 80,
      rows: 24,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    searchRef.current = search;
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    registerTerminal(spec.id, term);

    // ⌘C/Ctrl+C copies the selection when there is one, otherwise falls through
    // as SIGINT. ⌘V/Ctrl+V returns false so xterm never sends the raw ^V
    // control character to the PTY — Claude Code CLI and other TUI apps break
    // when they receive ^V ahead of the pasted text. The actual clipboard write
    // comes from the Electron Edit-menu { role: 'paste' } action, which fires
    // webContents.paste() → a single DOM paste event → xterm's bracketed-paste-
    // aware handler → PTY. Returning false here without a manual write avoids
    // the double-paste that existed before ec34939.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return true;
      const k = ev.key.toLowerCase();
      if (k === 'c') {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          void navigator.clipboard.writeText(sel).catch(() => undefined);
          return false; // we handled it
        }
        return true; // no selection — let Ctrl+C reach the shell
      }
      if (k === 'v') {
        return false; // block ^V; paste arrives via Electron menu role
      }
      return true;
    });

    offDataRef.current = window.api.pty.onData(spec.id, (data) => {
      term.write(data);
      if (!focusedRef.current) markActivity(spec.id, 'data');
      if (data.charCodeAt(data.indexOf(String.fromCharCode(7))) === 7 && !focusedRef.current) markActivity(spec.id, "bell");
    });
    offExitRef.current = window.api.pty.onExit(spec.id, (ev) => {
      term.write(`\r\n\x1b[2;37m[process exited with code ${ev.exitCode}]\x1b[0m\r\n`);
      ptySpawnedRef.current = false;
      if (aliveRef.current) setExited({ code: ev.exitCode, signal: ev.signal });
    });

    term.onData((data) => window.api.pty.write(spec.id, data));
    term.onResize(({ cols, rows }) => window.api.pty.resize(spec.id, cols, rows));

    // OSC 7: shells emit `file://host/abs/path` after cd. Update title/cwd live.
    term.parser.registerOscHandler(7, (data: string) => {
      try {
        const m = data.match(/^file:\/\/[^/]*(\/.+)$/);
        if (m && m[1]) props.onCwdChanged(decodeURIComponent(m[1]));
      } catch {
        /* ignore */
      }
      return false;
    });

    // Gate pty.create on first real ResizeObserver tick (avoids NaN/0 sizing race)
    const ro = new ResizeObserver(() => {
      if (gen !== generationRef.current) return;
      if (!ptySpawnedRef.current) {
        const rect = hostRef.current?.getBoundingClientRect();
        if (rect && rect.width > 20 && rect.height > 20) startPty(term, fit);
      } else {
        safeFit(fit);
      }
    });
    ro.observe(hostRef.current);

    // Safety net: if RO never fires (unlikely), try once more on next frame
    const raf = requestAnimationFrame(() => {
      if (!ptySpawnedRef.current && aliveRef.current) startPty(term, fit);
    });

    return () => {
      aliveRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offDataRef.current?.();
      offExitRef.current?.();
      if (ptySpawnedRef.current) {
        window.api.pty.dispose(spec.id);
      }
      unregisterTerminal(spec.id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      ptySpawnedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id]);

  useEffect(() => {
    if (focused) {
      termRef.current?.focus();
      clearActivity(spec.id);
    }
  }, [focused, zoomed, spec.id]);

  // Poll cwd as a fallback to OSC 7
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !ptySpawnedRef.current) return;
      const cwd = await window.api.pty.getCwd(spec.id);
      if (!cancelled && cwd && cwd !== spec.cwd) props.onCwdChanged(cwd);
    };
    const i = setInterval(tick, 3000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(i);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, spec.id, spec.cwd]);

  // When this pane's visibility changes (zoom toggle, or focus change in
  // tabs/zoom modes where unfocused panes are display:none), re-fit AND force
  // a repaint. fit() alone is a no-op when cols/rows are unchanged, which
  // leaves the DOM renderer showing a blank buffer after the pane reappears.
  useEffect(() => {
    const id = setTimeout(() => {
      safeFit(fitRef.current);
      const term = termRef.current;
      if (term) term.refresh(0, term.rows - 1);
    }, 60);
    return () => clearTimeout(id);
  }, [zoomed, focused]);

  // Apply live settings changes
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = props.fontSize;
    termRef.current.options.fontFamily = props.fontFamily;
    termRef.current.options.theme = props.themeMode === 'light' ? lightTheme : darkTheme;
    setTimeout(() => safeFit(fitRef.current), 50);
  }, [props.fontSize, props.fontFamily, props.themeMode]);

  // Listen for context-menu-dispatched restart/clear events for this terminal
  useEffect(() => {
    const onRestart = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id: string };
      if (detail?.id === spec.id) restartShell();
    };
    const onClear = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id: string };
      if (detail?.id === spec.id) termRef.current?.clear();
    };
    document.addEventListener('tg:restart', onRestart);
    document.addEventListener('tg:clear', onClear);
    return () => {
      document.removeEventListener('tg:restart', onRestart);
      document.removeEventListener('tg:clear', onClear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id]);

  // ⌘R restart, ⌘F search when focused
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r' && exited) {
        e.preventDefault();
        restartShell();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearching((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, exited]);

  const commitName = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== spec.title) onRename(trimmed);
    else setName(spec.title);
  };

  return (
    <div
      className={`pane ${focused ? 'focused' : ''} ${zoomed ? 'zoomed' : ''} ${exited ? 'exited' : ''}`}
      data-pane-id={spec.id}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        e.preventDefault();
        onFocus();
        props.onContextMenu(e);
      }}
    >
      <div
        className="pane-header"
        onPointerDown={(e) => {
          if (!editing && e.button === 0) props.onHeaderPointerDown(e);
        }}
      >
        <div className="traffic">
          <div className="dot" />
          <div className="dot" />
          <div className="dot" />
        </div>
        <div
          className={`title ${editing ? 'editable' : ''}`}
          onDoubleClick={() => setEditing(true)}
          onClick={(e) => {
            if (focused) {
              e.stopPropagation();
              setEditing(true);
            }
          }}
        >
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setName(spec.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            spec.title
          )}
        </div>
        <div className="actions">
          {exited && (
            <button title="Restart shell (⌘R)" onClick={restartShell} className="restart">
              ↻ Restart
            </button>
          )}
          <button title="Zoom (⌘E)" onClick={onZoom}>
            {zoomed ? '◱' : '⛶'}
          </button>
          <button title="Clear (⌘K)" onClick={() => termRef.current?.clear()}>
            Clr
          </button>
          <button title="Close (⌘W)" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="term-host" ref={hostRef}>
        {searching && (
          <div className="search-bar" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="Find in buffer…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearching(false);
                  searchRef.current?.clearDecorations();
                  termRef.current?.focus();
                } else if (e.key === 'Enter') {
                  if (e.shiftKey) searchRef.current?.findPrevious(searchQuery);
                  else searchRef.current?.findNext(searchQuery);
                }
              }}
            />
            <button
              title="Previous"
              onClick={() => searchRef.current?.findPrevious(searchQuery)}
            >
              ↑
            </button>
            <button title="Next" onClick={() => searchRef.current?.findNext(searchQuery)}>
              ↓
            </button>
            <button
              title="Close (Esc)"
              onClick={() => {
                setSearching(false);
                searchRef.current?.clearDecorations();
                termRef.current?.focus();
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
