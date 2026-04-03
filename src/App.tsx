import { useState, useEffect, useCallback, useRef } from 'react';
import { MultiplayerEngine, GameState, PlayerId, ShipCell, ShipData, GridCell, CellShot } from './multiplayer';
import './styles.css';

// ════════════════════════════════════════════════════════════
// AUDIO ENGINE
// ════════════════════════════════════════════════════════════
let audioCtx: AudioContext | null = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playSound(type: string) {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;
    if (type === 'miss') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(700, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.28);
      g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.32);
    } else if (type === 'hit') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.22);
      g.gain.setValueAtTime(0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    } else if (type === 'destroy') {
      [{ tp: 'sine' as const, f: 90, e: 18, d: 0.7, v: 0.28 },
       { tp: 'sawtooth' as const, f: 65, e: 15, d: 0.6, v: 0.14 }].forEach(l => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = l.tp; o.frequency.setValueAtTime(l.f, t);
        o.frequency.exponentialRampToValueAtTime(l.e, t + l.d);
        g.gain.setValueAtTime(l.v, t); g.gain.exponentialRampToValueAtTime(0.001, t + l.d);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + l.d + 0.05);
      });
    } else if (type === 'win') {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(freq, t + i * 0.18);
        g.gain.setValueAtTime(0, t + i * 0.18);
        g.gain.linearRampToValueAtTime(0.22, t + i * 0.18 + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.5);
        o.connect(g).connect(ctx.destination); o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.55);
      });
    } else if (type === 'place') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(440, t);
      o.frequency.setValueAtTime(700, t + 0.06);
      g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.16);
    } else if (type === 'rotate') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(350, t);
      o.frequency.linearRampToValueAtTime(580, t + 0.07);
      g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.12);
    }
  } catch { /* ignore */ }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
const DIR_LABELS = ['↑ North', '→ East', '↓ South', '← West'];
const DIR_ARROWS = ['↑', '→', '↓', '←'];
const SHIPS_COUNT = 3;
const GRID = 10;

const PLANE_SHAPE = [
  { dx: 0, dy: 0, isHead: true },
  { dx: -1, dy: 1, isHead: false },
  { dx: 0, dy: 1, isHead: false },
  { dx: 1, dy: 1, isHead: false },
  { dx: 0, dy: 2, isHead: false },
  { dx: -1, dy: 3, isHead: false },
  { dx: 0, dy: 3, isHead: false },
  { dx: 1, dy: 3, isHead: false },
];

function getRotatedShape(rot: number) {
  return PLANE_SHAPE.map(({ dx, dy, isHead }) => {
    let rx: number, ry: number;
    switch (((rot % 4) + 4) % 4) {
      case 0: rx = dx; ry = dy; break;
      case 1: rx = -dy; ry = dx; break;
      case 2: rx = -dx; ry = -dy; break;
      case 3: rx = dy; ry = -dx; break;
      default: rx = dx; ry = dy;
    }
    return { dx: rx, dy: ry, isHead };
  });
}

function getShipCells(headCol: number, headRow: number, rot: number): ShipCell[] {
  return getRotatedShape(rot).map(({ dx, dy, isHead }) => ({
    col: headCol + dx, row: headRow + dy, isHead,
  }));
}

function isValidPlacement(cells: ShipCell[], grid: (GridCell | null)[][]): boolean {
  return cells.every(({ col, row }) =>
    col >= 0 && col < GRID && row >= 0 && row < GRID && grid[row][col] === null
  );
}

function genRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SFB-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ════════════════════════════════════════════════════════════
// LOBBY COMPONENT
// ════════════════════════════════════════════════════════════
function Lobby({ onCreateRoom, onJoinRoom, connecting, error }: {
  onCreateRoom: () => Promise<void>;
  onJoinRoom: (code: string) => Promise<void>;
  connecting: boolean;
  error: string;
}) {
  const [joinCode, setJoinCode] = useState('');

  const handleJoin = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    await onJoinRoom(code);
  };

  return (
    <div className="lobby-container">
      <div className="lobby-box">
        <h1 className="game-title">✦ SPACE FLEET BATTLE ✦</h1>
        <p className="lobby-subtitle">Online Multiplayer — Play with a friend anywhere</p>

        <div className="lobby-divider"><span className="lobby-divider-text">CREATE A ROOM</span></div>
        <button className="btn btn-primary btn-lg" onClick={onCreateRoom} disabled={connecting}>
          {connecting ? 'Connecting...' : '🚀 Create New Room'}
        </button>

        <div className="lobby-divider"><span className="lobby-divider-text">OR JOIN A ROOM</span></div>
        <div className="join-row">
          <input className="join-input" type="text" placeholder="Enter room code..."
            value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleJoin()} maxLength={10} />
          <button className="btn btn-teal" onClick={handleJoin} disabled={connecting}>
            {connecting ? 'Connecting...' : 'Join'}
          </button>
        </div>

        {error && <div className="error-msg">⚠ {error}</div>}

        <div className="lobby-divider"><span className="lobby-divider-text">SELECT MAP</span></div>
        <div className="map-selector">
          <button className="btn map-btn map-btn-space">🌌 Space</button>
          <button className="btn map-btn map-btn-ocean">🌊 Ocean</button>
          <button className="btn map-btn map-btn-lava">🌋 Lava</button>
          <button className="btn map-btn map-btn-ice">❄ Ice</button>
        </div>

        <div className="lobby-info">
          <h3>How to Play</h3>
          <ol>
            <li>One player clicks <b>Create New Room</b> and shares the room code</li>
            <li>The other player enters the code and clicks <b>Join</b></li>
            <li>Both players place their ships secretly</li>
            <li>Take turns attacking the enemy fleet!</li>
          </ol>
          <p className="lobby-note">💡 Works across different devices and networks. Uses MQTT over WebSockets — no setup needed!</p>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// WAITING ROOM
// ════════════════════════════════════════════════════════════
function WaitingRoom({ engine, room, myId }: { engine: MultiplayerEngine; room: string; myId: PlayerId }) {
  const [copied, setCopied] = useState(false);
  const [opponentReady, setOpponentReady] = useState(false);
  const [chatMsg, setChatMsg] = useState('');
  const [chatLog, setChatLog] = useState<{ from: PlayerId; text: string }[]>([]);
  const readySent = useRef(false);

  const copyCode = () => {
    navigator.clipboard.writeText(room).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    const handleChat = (playerId: PlayerId, text: string) => {
      setChatLog(prev => [...prev, { from: playerId, text }]);
    };
    engine.onChatHandler(handleChat);

    // Check opponent ready periodically
    const interval = setInterval(() => {
      const oppReady = engine.isOpponentReady();
      setOpponentReady(oppReady);
      // Auto-send ready when opponent connects
      if (oppReady && !readySent.current) {
        readySent.current = true;
        engine.ready();
      }
    }, 500);

    return () => { clearInterval(interval); engine.onChatHandler(() => {}); };
  }, [engine]);

  const sendChat = () => {
    if (!chatMsg.trim()) return;
    engine.sendChat(chatMsg.trim());
    setChatLog(prev => [...prev, { from: myId, text: chatMsg.trim() }]);
    setChatMsg('');
  };

  return (
    <div className="waiting-container">
      <div className="waiting-box">
        <h2 className="waiting-title">
          {myId === 'p1' ? '🚀 Room Created!' : '🎮 Joined Room!'}
        </h2>
        <p className="waiting-subtitle">
          {myId === 'p1' ? 'Share this code with your opponent:' : 'Waiting for game to start...'}
        </p>
        {myId === 'p1' && (
          <div className="room-code-display">
            <span className="room-code-text">{room}</span>
            <button className="btn btn-sm btn-teal" onClick={copyCode}>
              {copied ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
        )}

        <div className="waiting-status">
          <div className={`status-dot ${opponentReady ? 'online' : 'offline'}`} />
          <span>
            {opponentReady
              ? (myId === 'p1' ? 'Opponent connected! Starting game...' : 'Connected! Starting game...')
              : 'Waiting for opponent...'}
          </span>
        </div>

        {/* Chat */}
        <div className="chat-box">
          <div className="chat-messages">
            {chatLog.length === 0 && <div className="chat-empty">No messages yet</div>}
            {chatLog.map((msg, i) => (
              <div key={i} className={`chat-msg ${msg.from === myId ? 'chat-msg-me' : 'chat-msg-other'}`}>
                <span className="chat-sender">{msg.from === 'p1' ? 'Player 1' : 'Player 2'}:</span>
                <span className="chat-text">{msg.text}</span>
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input className="chat-input" type="text" placeholder="Type a message..."
              value={chatMsg} onChange={e => setChatMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendChat()} />
            <button className="btn btn-sm btn-teal" onClick={sendChat}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// GRID COMPONENT
// ════════════════════════════════════════════════════════════
function GameGrid({
  grid, shots, ships, label, interactive, onClick, myShips,
}: {
  grid: (GridCell | null)[][];
  shots: (CellShot | null)[][];
  ships: ShipData[];
  label: string;
  interactive?: boolean;
  onClick?: (row: number, col: number) => void;
  myShips?: boolean;
}) {
  return (
    <div className="board-section">
      <div className="board-label">{label}</div>
      <div className="game-grid">
        {grid.map((row, r) =>
          row.map((cell, c) => {
            const shot = shots[r][c];
            let cls = 'grid-cell';
            let content = '';

            if (shot === 'destroyed') {
              cls += ' destroyed';
              content = '💥';
            } else if (shot === 'hit') {
              cls += ' hit';
              content = '⊕';
            } else if (shot === 'miss') {
              cls += ' miss';
              content = 'X';
            } else if (cell && myShips) {
              cls += cell.isHead ? ' ship-head' : ' ship-body';
              if (cell.isHead) content = '✦';
            } else if (interactive && !shot) {
              cls += ' targetable';
            }

            return (
              <div key={`${r}-${c}`} className={cls}
                onClick={() => interactive && !shot && onClick?.(r, c)}>
                {content}
              </div>
            );
          })
        )}
      </div>
      {/* Ship indicators */}
      <div className="ship-indicators">
        {ships.map((ship, i) => (
          <div key={i} className={`ship-indicator ${ship.destroyed ? 'destroyed' : 'alive'}`}>
            {ship.destroyed ? `Ship ${i + 1} 💥` : myShips ? `Ship ${i + 1} ✓` : `Ship ${i + 1} ?`}
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PLACEMENT SCREEN
// ════════════════════════════════════════════════════════════
function PlacementScreen({
  engine, state, myId,
}: {
  engine: MultiplayerEngine;
  state: GameState;
  myId: PlayerId;
}) {
  const [rotation, setRotation] = useState(0);
  const [hoverCells, setHoverCells] = useState<ShipCell[]>([]);
  const [hoverValid, setHoverValid] = useState(false);
  const myBoard = state.players[myId];
  const placed = myBoard.ships.length;
  const isMyTurn = (myId === 'p1' && state.phase === 'PLACE_P1') || (myId === 'p2' && state.phase === 'PLACE_P2');

  useEffect(() => {
    setHoverCells([]);
    setHoverValid(false);
  }, [rotation]);

  const handleCellHover = (r: number, c: number) => {
    const cells = getShipCells(c, r, rotation);
    const valid = isValidPlacement(cells, myBoard.grid);
    setHoverCells(cells);
    setHoverValid(valid);
  };

  const handleCellClick = (r: number, c: number) => {
    if (!isMyTurn) return;
    const cells = getShipCells(c, r, rotation);
    if (!isValidPlacement(cells, myBoard.grid)) return;
    playSound('place');
    engine.placeShip(c, r, rotation);
  };

  const rotate = () => {
    setRotation(prev => (prev + 1) % 4);
    playSound('rotate');
  };

  return (
    <div className="placement-container">
      <div className="placement-header">
        <h2>Place Ship {placed + 1} of {SHIPS_COUNT}</h2>
        <div className="placement-controls">
          <button className="btn btn-sm btn-teal" onClick={rotate}>
            Rotate [{DIR_ARROWS[rotation]}] {DIR_LABELS[rotation]}
          </button>
          <span className="placement-count">{placed} / {SHIPS_COUNT} placed</span>
        </div>
      </div>

      <div className="game-grid"
        onMouseLeave={() => { setHoverCells([]); setHoverValid(false); }}>
        {myBoard.grid.map((row, r) =>
          row.map((cell, c) => {
            const isHover = hoverCells.some(h => h.row === r && h.col === c);
            const isHoverHead = hoverCells.find(h => h.row === r && h.col === c)?.isHead;
            let cls = 'grid-cell';
            let content = '';

            if (cell) {
              cls += cell.isHead ? ' ship-head' : ' ship-body';
              if (cell.isHead) content = '✦';
            } else if (isHover && isMyTurn) {
              cls += hoverValid
                ? (isHoverHead ? ' preview-head' : ' preview-valid')
                : ' preview-invalid';
              if (isHoverHead) content = '✦';
            }

            return (
              <div key={`${r}-${c}`} className={cls}
                style={{ cursor: isMyTurn ? 'pointer' : 'default' }}
                onClick={() => handleCellClick(r, c)}
                onMouseEnter={() => handleCellHover(r, c)}>
                {content}
              </div>
            );
          })
        )}
      </div>

      {/* Mini shape preview */}
      <div className="shape-preview">
        <span>SHIP SHAPE ({DIR_LABELS[rotation]}):</span>
        <MiniShape rot={rotation} />
      </div>

      {!isMyTurn && (
        <div className="waiting-msg">⏳ Waiting for opponent to place ships...</div>
      )}
    </div>
  );
}

function MiniShape({ rot }: { rot: number }) {
  const shape = getRotatedShape(rot);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  shape.forEach(({ dx, dy }) => { minX = Math.min(minX, dx); maxX = Math.max(maxX, dx); minY = Math.min(minY, dy); maxY = Math.max(maxY, dy); });
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const lookup: Record<string, boolean> = {};
  shape.forEach(({ dx, dy, isHead }) => { lookup[`${dx - minX},${dy - minY}`] = isHead; });

  return (
    <div className="mini-shape" style={{ gridTemplateColumns: `repeat(${w}, 14px)`, gridTemplateRows: `repeat(${h}, 14px)` }}>
      {Array.from({ length: h }, (_, y) =>
        Array.from({ length: w }, (_, x) => {
          const k = `${x},${y}`;
          const isShip = k in lookup;
          const isHead = lookup[k];
          return (
            <div key={k} className={`mini-cell ${isShip ? (isHead ? 'mini-head' : 'mini-body') : ''}`}>
              {isHead ? '✦' : ''}
            </div>
          );
        })
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// BATTLE SCREEN
// ════════════════════════════════════════════════════════════
function BattleScreen({
  engine, state, myId,
}: {
  engine: MultiplayerEngine;
  state: GameState;
  myId: PlayerId;
}) {
  const opponent: PlayerId = myId === 'p1' ? 'p2' : 'p1';
  const myBoard = state.players[myId];
  const enemyBoard = state.players[opponent];
  const isMyTurn = state.currentPlayer === myId && !state.processing && !state.winner;

  const handleAttack = (row: number, col: number) => {
    if (!isMyTurn) return;
    const result = engine.attack(row, col);
    if (!result) return;

    if (result.type === 'miss') playSound('miss');
    else if (result.type === 'hit') playSound('hit');
    else if (result.type === 'destroyed') playSound('destroy');
  };

  const myAlive = myBoard.ships.filter(s => !s.destroyed).length;
  const enemyAlive = enemyBoard.ships.filter(s => !s.destroyed).length;

  return (
    <div className="battle-container">
      <div className="battle-status">
        {state.winner ? (
          <span className="status-win">🏆 {state.winner === myId ? 'YOU WIN!' : 'OPPONENT WINS!'}</span>
        ) : isMyTurn ? (
          <span className="status-turn">⚔ Your Turn — Fire at the enemy!</span>
        ) : (
          <span className="status-waiting">⏳ Opponent's turn...</span>
        )}
        <span className="status-ships">Your ships: {myAlive} · Enemy ships: {enemyAlive}</span>
      </div>

      <div className="battle-boards">
        <GameGrid
          grid={myBoard.grid}
          shots={myBoard.shots}
          ships={myBoard.ships}
          label="🛡 YOUR FLEET"
          myShips={true}
        />

        <div className="battle-divider">⚔</div>

        <GameGrid
          grid={enemyBoard.grid}
          shots={enemyBoard.shots}
          ships={enemyBoard.ships}
          label="🎯 ENEMY WATERS"
          interactive={isMyTurn}
          onClick={handleAttack}
        />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// WIN SCREEN
// ════════════════════════════════════════════════════════════
function WinScreen({ engine, state, myId }: { engine: MultiplayerEngine; state: GameState; myId: PlayerId }) {
  const iWon = state.winner === myId;

  useEffect(() => {
    if (iWon) playSound('win');
  }, [iWon]);

  return (
    <div className="win-container">
      <div className="win-box">
        <div className="win-trophy">🏆</div>
        <h2 className="win-title">VICTORY!</h2>
        <p className={`win-subtitle ${iWon ? 'win-text' : 'lose-text'}`}>
          {iWon ? 'You destroyed all enemy ships!' : 'Your fleet has been obliterated!'}
        </p>
        <div className="win-emojis">🎉 🚀 🎉</div>
        <button className="btn btn-primary btn-lg" onClick={() => engine.requestRematch()}>
          PLAY AGAIN
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════
export default function App() {
  const [engine] = useState(() => new MultiplayerEngine());
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [myId, setMyId] = useState<PlayerId | null>(null);
  const [room, setRoom] = useState('');
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    engine.onStateChangeHandler((state) => {
      setGameState({ ...state });
    });

    engine.onConnectionChangeHandler((isConnected, error) => {
      setConnected(isConnected);
      if (error) setConnError(error);
      if (isConnected) {
        setMyId(engine.getMyId());
        setRoom(engine.getRoom());
        setConnecting(false);
      }
    });

    return () => { engine.disconnect(); };
  }, [engine]);

  const handleCreateRoom = useCallback(async () => {
    setConnecting(true);
    setConnError('');
    try {
      const roomCode = genRoomCode();
      await engine.connect(roomCode, true);
    } catch (e: any) {
      setConnError(e?.message || 'Failed to create room. Check your internet.');
      setConnecting(false);
    }
  }, [engine]);

  const handleJoinRoom = useCallback(async (code: string) => {
    setConnecting(true);
    setConnError('');
    try {
      await engine.connect(code, false);
    } catch (e: any) {
      setConnError(e?.message || 'Failed to join room. Check the code and your internet.');
      setConnecting(false);
    }
  }, [engine]);

  const handleDisconnect = useCallback(() => {
    engine.disconnect();
    setConnected(false);
    setConnecting(false);
    setGameState(null);
    setMyId(null);
    setRoom('');
    setConnError('');
  }, [engine]);

  // Not connected yet → show lobby
  if (!connected && !connecting) {
    return (
      <div className="app-root">
        <Lobby
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          connecting={connecting}
          error={connError}
        />
      </div>
    );
  }

  // Connected but no state yet
  if (!gameState) {
    return (
      <div className="app-root">
        <div className="loading-container">
          <div className="loading-spinner" />
          <p>Connecting to room {room}...</p>
          {connError && <p className="error-msg">{connError}</p>}
          <button className="btn btn-teal" onClick={handleDisconnect}>Back</button>
        </div>
      </div>
    );
  }

  // Connected — show game
  const phase = gameState.phase;

  return (
    <div className="app-root">
      <header className="game-header">
        <h1 className="game-title-small">✦ SPACE FLEET BATTLE ✦</h1>
        <div className="header-info">
          <span className="room-badge">Room: {room}</span>
          <span className={`player-badge ${myId === 'p1' ? 'p1' : 'p2'}`}>
            You are Player {myId === 'p1' ? '1' : '2'}
          </span>
          <button className="btn btn-sm btn-leave" onClick={handleDisconnect}>Leave</button>
        </div>
      </header>

      <main className="game-main">
        {phase === 'LOBBY' && (
          <WaitingRoom engine={engine} room={room} myId={myId!} />
        )}

        {(phase === 'PLACE_P1' || phase === 'PLACE_P2') && myId && (
          <PlacementScreen engine={engine} state={gameState} myId={myId} />
        )}

        {phase === 'BATTLE' && myId && (
          <BattleScreen engine={engine} state={gameState} myId={myId} />
        )}

        {phase === 'WIN' && myId && (
          <WinScreen engine={engine} state={gameState} myId={myId} />
        )}
      </main>
    </div>
  );
}
