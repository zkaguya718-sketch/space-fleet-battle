/**
 * Multiplayer engine using MQTT over WebSockets via a free public broker.
 * No API keys needed. Works from any device/network.
 *
 * Broker: broker.hivemq.com (public, free, no auth)
 * Also supports BroadcastChannel for same-browser testing.
 */

// ── Types ──────────────────────────────────────────────
export type PlayerId = 'p1' | 'p2';

export interface ShipCell {
  col: number;
  row: number;
  isHead: boolean;
}

export interface ShipData {
  cells: ShipCell[];
  destroyed: boolean;
  hitCells: Set<string>;
}

export interface GridCell {
  shipIdx: number;
  isHead: boolean;
}

export type CellShot = 'miss' | 'hit' | 'destroyed';

export interface PlayerBoard {
  ships: ShipData[];
  grid: (GridCell | null)[][];
  shots: (CellShot | null)[][];
}

export type GamePhase =
  | 'LOBBY'
  | 'PLACE_P1'
  | 'PLACE_P2'
  | 'BATTLE'
  | 'WIN';

export interface AttackResult {
  type: 'miss' | 'hit' | 'destroyed';
  ship?: ShipData;
}

export interface GameState {
  phase: GamePhase;
  currentPlayer: PlayerId;
  rotation: number;
  players: Record<PlayerId, PlayerBoard>;
  winner: PlayerId | null;
  processing: boolean;
}

// MQTT message types
export type MqttMsg =
  | { type: 'join'; playerId: PlayerId; room: string }
  | { type: 'ready'; playerId: PlayerId }
  | { type: 'place'; playerId: PlayerId; headCol: number; headRow: number; rot: number }
  | { type: 'attack'; playerId: PlayerId; row: number; col: number }
  | { type: 'state'; state: string }
  | { type: 'sync'; playerId: PlayerId }
  | { type: 'rematch'; playerId: PlayerId }
  | { type: 'chat'; playerId: PlayerId; text: string };

// ── Constants ──────────────────────────────────────────
const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const SHIPS_COUNT = 3;
const GRID = 10;

const planeShapeOffsets = [
  { x:  0, y: 0, isHead: true  },
  { x: -1, y: 1, isHead: false },
  { x:  0, y: 1, isHead: false },
  { x:  1, y: 1, isHead: false },
  { x:  0, y: 2, isHead: false },
  { x: -1, y: 3, isHead: false },
  { x:  0, y: 3, isHead: false },
  { x:  1, y: 3, isHead: false },
];

// ── Helpers ────────────────────────────────────────────
function emptyGrid<T>(): T[][] {
  return Array.from({ length: GRID }, () => Array(GRID).fill(null));
}

function freshPlayer(): PlayerBoard {
  return { ships: [], grid: emptyGrid(), shots: emptyGrid() };
}

function getRotatedShape(rot: number) {
  return planeShapeOffsets.map(({ x, y, isHead }) => {
    let rx: number, ry: number;
    switch (((rot % 4) + 4) % 4) {
      case 0: rx =  x; ry =  y; break;
      case 1: rx = -y; ry =  x; break;
      case 2: rx = -x; ry = -y; break;
      case 3: rx =  y; ry = -x; break;
      default: rx = x; ry = y;
    }
    return { x: rx, y: ry, isHead };
  });
}

function getShipCells(headCol: number, headRow: number, rot: number): ShipCell[] {
  return getRotatedShape(rot).map(({ x, y, isHead }) => ({
    col: headCol + x, row: headRow + y, isHead
  }));
}

function isValidPlacement(cells: ShipCell[], board: PlayerBoard): boolean {
  return cells.every(({ col, row }) =>
    col >= 0 && col < GRID && row >= 0 && row < GRID && board.grid[row][col] === null
  );
}

function placeShip(board: PlayerBoard, headCol: number, headRow: number, rot: number): boolean {
  const cells = getShipCells(headCol, headRow, rot);
  if (!isValidPlacement(cells, board)) return false;
  const idx = board.ships.length;
  board.ships.push({ cells, destroyed: false, hitCells: new Set() });
  cells.forEach(({ col, row, isHead }) => {
    board.grid[row][col] = { shipIdx: idx, isHead };
  });
  return true;
}

function processAttack(state: GameState, attacker: PlayerId, row: number, col: number): AttackResult | null {
  const defender: PlayerId = attacker === 'p1' ? 'p2' : 'p1';
  const dd = state.players[defender];
  if (dd.shots[row][col] !== null) return null;

  const cell = dd.grid[row][col];
  if (!cell) {
    dd.shots[row][col] = 'miss';
    return { type: 'miss' };
  }

  const ship = dd.ships[cell.shipIdx];

  if (cell.isHead) {
    ship.destroyed = true;
    ship.cells.forEach(c => {
      dd.shots[c.row][c.col] = 'destroyed';
      ship.hitCells.add(`${c.col},${c.row}`);
    });
    if (dd.ships.every(s => s.destroyed)) state.winner = attacker;
    return { type: 'destroyed', ship };
  }

  ship.hitCells.add(`${col},${row}`);
  dd.shots[row][col] = 'hit';

  if (ship.hitCells.size === ship.cells.length) {
    ship.destroyed = true;
    ship.cells.forEach(c => { dd.shots[c.row][c.col] = 'destroyed'; });
    if (dd.ships.every(s => s.destroyed)) state.winner = attacker;
    return { type: 'destroyed', ship };
  }

  return { type: 'hit' };
}

// Serialize / deserialize state (convert Sets to arrays for JSON)
interface SerializablePlayerBoard {
  ships: { cells: ShipCell[]; destroyed: boolean; hitCells: string[] }[];
  grid: (GridCell | null)[][];
  shots: (CellShot | null)[][];
}

function serializeState(state: GameState): string {
  return JSON.stringify({
    phase: state.phase,
    currentPlayer: state.currentPlayer,
    rotation: state.rotation,
    winner: state.winner,
    processing: state.processing,
    players: {
      p1: {
        ships: state.players.p1.ships.map(s => ({ cells: s.cells, destroyed: s.destroyed, hitCells: [...s.hitCells] })),
        grid: state.players.p1.grid,
        shots: state.players.p1.shots,
      },
      p2: {
        ships: state.players.p2.ships.map(s => ({ cells: s.cells, destroyed: s.destroyed, hitCells: [...s.hitCells] })),
        grid: state.players.p2.grid,
        shots: state.players.p2.shots,
      },
    },
  });
}

function deserializeState(json: string): GameState {
  const raw = JSON.parse(json) as {
    phase: GamePhase;
    currentPlayer: PlayerId;
    rotation: number;
    winner: PlayerId | null;
    processing: boolean;
    players: Record<PlayerId, SerializablePlayerBoard>;
  };
  return {
    phase: raw.phase,
    currentPlayer: raw.currentPlayer,
    rotation: raw.rotation,
    winner: raw.winner,
    processing: raw.processing,
    players: {
      p1: {
        ships: raw.players.p1.ships.map(s => ({ ...s, hitCells: new Set(s.hitCells) })),
        grid: raw.players.p1.grid,
        shots: raw.players.p1.shots,
      },
      p2: {
        ships: raw.players.p2.ships.map(s => ({ ...s, hitCells: new Set(s.hitCells) })),
        grid: raw.players.p2.grid,
        shots: raw.players.p2.shots,
      },
    },
  };
}

// ── Transport Layer ────────────────────────────────────
type TransportHandler = (msg: MqttMsg) => void;

interface Transport {
  connect(room: string, asHost: boolean): Promise<void>;
  send(msg: MqttMsg): void;
  onMessage(handler: TransportHandler): void;
  disconnect(): void;
}

/** MQTT transport using the global mqtt object from CDN */
class MqttTransport implements Transport {
  private client: any = null;
  private handler: TransportHandler | null = null;
  private room = '';

  onMessage(handler: TransportHandler) {
    this.handler = handler;
  }

  async connect(roomCode: string, _asHost: boolean): Promise<void> {
    this.room = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    return new Promise((resolve, reject) => {
      // Check if mqtt is available from CDN
      const mqttGlobal = (window as any).mqtt;
      if (!mqttGlobal) {
        reject(new Error('MQTT library not loaded. Check your internet connection.'));
        return;
      }

      const clientId = `sfb_${this.room}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.client = mqttGlobal.connect(BROKER, {
        clientId,
        clean: true,
        connectTimeout: 10000,
        reconnectPeriod: 0, // Don't auto-reconnect, we handle it
      });

      const timeout = setTimeout(() => {
        if (this.client) {
          this.client.end(true);
          this.client = null;
        }
        reject(new Error('Connection timed out. Check your internet connection.'));
      }, 15000);

      this.client.on('connect', () => {
        clearTimeout(timeout);
        this.client.subscribe(`sfb/${this.room}/msg`, { qos: 1 }, (err: any) => {
          if (err) {
            reject(new Error('Failed to subscribe: ' + err.message));
            return;
          }
          resolve();
        });
      });

      this.client.on('message', (_topic: string, payload: any) => {
        try {
          const msg: MqttMsg = JSON.parse(payload.toString());
          this.handler?.(msg);
        } catch (e) {
          console.warn('Bad message:', e);
        }
      });

      this.client.on('error', (err: any) => {
        clearTimeout(timeout);
        console.error('MQTT error:', err);
        reject(new Error('Connection error: ' + (err.message || 'Unknown error')));
      });

      this.client.on('close', () => {
        // Connection closed
      });

      this.client.on('offline', () => {
        // Offline
      });
    });
  }

  send(msg: MqttMsg) {
    if (!this.client) return;
    try {
      this.client.publish(`sfb/${this.room}/msg`, JSON.stringify(msg), { qos: 1 });
    } catch (e) {
      console.warn('Failed to send message:', e);
    }
  }

  disconnect() {
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }
  }
}

/** BroadcastChannel transport for same-browser testing */
class BroadcastChannelTransport implements Transport {
  private channel: BroadcastChannel | null = null;
  private handler: TransportHandler | null = null;
  private room = '';

  onMessage(handler: TransportHandler) {
    this.handler = handler;
  }

  async connect(roomCode: string, _asHost: boolean): Promise<void> {
    this.room = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    return new Promise((resolve) => {
      this.channel = new BroadcastChannel(`sfb_${this.room}`);
      this.channel.onmessage = (event) => {
        try {
          const msg: MqttMsg = event.data;
          this.handler?.(msg);
        } catch (e) {
          console.warn('Bad broadcast message:', e);
        }
      };
      // Small delay to ensure channel is ready
      setTimeout(resolve, 100);
    });
  }

  send(msg: MqttMsg) {
    if (!this.channel) return;
    this.channel.postMessage(msg);
  }

  disconnect() {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

// ── Multiplayer Engine ─────────────────────────────────
export class MultiplayerEngine {
  private transport: Transport | null = null;
  private room: string = '';
  private myId: PlayerId | null = null;
  private state: GameState;
  private onStateChange: ((state: GameState) => void) | null = null;
  private onConnectionChange: ((connected: boolean, error?: string) => void) | null = null;
  private onChat: ((playerId: PlayerId, text: string) => void) | null = null;
  private connected = false;
  private opponentReady = false;

  constructor() {
    this.state = this.freshState();
  }

  private freshState(): GameState {
    return {
      phase: 'LOBBY',
      currentPlayer: 'p1',
      rotation: 0,
      players: { p1: freshPlayer(), p2: freshPlayer() },
      winner: null,
      processing: false,
    };
  }

  getState(): GameState {
    return this.state;
  }

  getMyId(): PlayerId | null {
    return this.myId;
  }

  getRoom(): string {
    return this.room;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isOpponentReady(): boolean {
    return this.opponentReady;
  }

  onStateChangeHandler(fn: (state: GameState) => void) {
    this.onStateChange = fn;
  }

  onConnectionChangeHandler(fn: (connected: boolean, error?: string) => void) {
    this.onConnectionChange = fn;
  }

  onChatHandler(fn: (playerId: PlayerId, text: string) => void) {
    this.onChat = fn;
  }

  private emitState() {
    if (!this.connected) return;
    this.transport?.send({ type: 'state', state: serializeState(this.state) });
  }

  private send(msg: MqttMsg) {
    if (!this.connected) return;
    this.transport?.send(msg);
  }

  connect(roomCode: string, asHost: boolean): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.room = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      this.myId = asHost ? 'p1' : 'p2';
      this.state = this.freshState();
      this.opponentReady = false;

      // Try MQTT first, fall back to BroadcastChannel
      const mqttGlobal = (window as any).mqtt;
      if (mqttGlobal) {
        this.transport = new MqttTransport();
        this.useBroadcastChannel = false;
      } else {
        console.warn('MQTT not available, using BroadcastChannel (same-browser only)');
        this.transport = new BroadcastChannelTransport();
        this.useBroadcastChannel = true;
      }

      this.transport.onMessage((msg) => this.handleMessage(msg));

      try {
        await this.transport.connect(this.room, asHost);
        this.connected = true;

        // Announce join
        this.send({ type: 'join', playerId: this.myId!, room: this.room });

        // Request state from host
        if (!asHost) {
          this.send({ type: 'sync', playerId: this.myId! });
        }

        this.onConnectionChange?.(true);
        this.onStateChange?.(this.state);
        resolve();
      } catch (e: any) {
        console.warn('MQTT failed, trying BroadcastChannel fallback:', e.message);
        // Fall back to BroadcastChannel
        this.transport = new BroadcastChannelTransport();
        this.useBroadcastChannel = true;
        this.transport.onMessage((msg) => this.handleMessage(msg));

        try {
          await this.transport.connect(this.room, asHost);
          this.connected = true;
          this.send({ type: 'join', playerId: this.myId!, room: this.room });
          if (!asHost) {
            this.send({ type: 'sync', playerId: this.myId! });
          }
          this.onConnectionChange?.(true);
          this.onStateChange?.(this.state);
          resolve();
        } catch (e2: any) {
          this.connected = false;
          this.onConnectionChange?.(false, e2.message || 'Failed to connect');
          reject(e2);
        }
      }
    });
  }

  private handleMessage(msg: MqttMsg) {
    try {
      if (msg.type === 'join') {
        if (msg.playerId !== this.myId) {
          this.opponentReady = true;
          // Host starts the game when opponent joins
          if (this.myId === 'p1' && this.state.phase === 'LOBBY') {
            this.state.phase = 'PLACE_P1';
            this.emitState();
            this.onStateChange?.(this.state);
          }
        }
      }

      if (msg.type === 'ready') {
        if (msg.playerId !== this.myId) {
          this.opponentReady = true;
          // Host starts the game when both are ready
          if (this.myId === 'p1' && this.state.phase === 'LOBBY') {
            this.state.phase = 'PLACE_P1';
            this.emitState();
            this.onStateChange?.(this.state);
          }
        }
      }

      if (msg.type === 'state') {
        // Only accept state from host (p1)
        if (this.myId === 'p2') {
          this.state = deserializeState(msg.state);
          this.onStateChange?.(this.state);
        }
      }

      if (msg.type === 'sync') {
        // Host responds with full state
        if (this.myId === 'p1') {
          this.send({ type: 'state', state: serializeState(this.state) });
        }
      }

      if (msg.type === 'place') {
        if (msg.playerId !== this.myId) {
          const board = this.state.players[msg.playerId];
          placeShip(board, msg.headCol, msg.headRow, msg.rot);
          // Check if all ships placed
          if (board.ships.length >= SHIPS_COUNT) {
            if (this.state.phase === 'PLACE_P1' && msg.playerId === 'p1') {
              this.state.phase = 'PLACE_P2';
            } else if (this.state.phase === 'PLACE_P2' && msg.playerId === 'p2') {
              this.state.phase = 'BATTLE';
              this.state.currentPlayer = 'p1';
            }
          }
          if (this.myId === 'p1') this.emitState();
          this.onStateChange?.(this.state);
        }
      }

      if (msg.type === 'attack') {
        if (msg.playerId !== this.myId) {
          const result = processAttack(this.state, msg.playerId, msg.row, msg.col);
          if (result) {
            if (this.state.winner) {
              this.state.phase = 'WIN';
            } else {
              this.state.currentPlayer = this.state.currentPlayer === 'p1' ? 'p2' : 'p1';
            }
            this.state.processing = false;
            if (this.myId === 'p1') this.emitState();
            this.onStateChange?.(this.state);
          }
        }
      }

      if (msg.type === 'rematch') {
        if (msg.playerId !== this.myId) {
          this.state = this.freshState();
          this.state.phase = 'PLACE_P1';
          this.opponentReady = false;
          if (this.myId === 'p1') this.emitState();
          this.onStateChange?.(this.state);
        }
      }

      if (msg.type === 'chat') {
        if (msg.playerId !== this.myId) {
          this.onChat?.(msg.playerId, msg.text);
        }
      }
    } catch (e) {
      console.warn('Error handling message:', e);
    }
  }

  // ── Player Actions ───────────────────────────────────

  ready() {
    this.send({ type: 'ready', playerId: this.myId! });
    if (this.myId === 'p1') {
      this.opponentReady = true;
      if (this.state.phase === 'LOBBY') {
        this.state.phase = 'PLACE_P1';
        this.emitState();
        this.onStateChange?.(this.state);
      }
    }
  }

  placeShip(headCol: number, headRow: number, rot: number): boolean {
    const board = this.state.players[this.myId!];
    if (!isValidPlacement(getShipCells(headCol, headRow, rot), board)) return false;
    placeShip(board, headCol, headRow, rot);
    this.send({ type: 'place', playerId: this.myId!, headCol, headRow, rot });
    if (board.ships.length >= SHIPS_COUNT) {
      if (this.state.phase === 'PLACE_P1' && this.myId === 'p1') {
        this.state.phase = 'PLACE_P2';
      } else if (this.state.phase === 'PLACE_P2' && this.myId === 'p2') {
        this.state.phase = 'BATTLE';
        this.state.currentPlayer = 'p1';
      }
    }
    if (this.myId === 'p1') this.emitState();
    this.onStateChange?.(this.state);
    return true;
  }

  attack(row: number, col: number): AttackResult | null {
    if (this.state.processing || this.state.winner) return null;
    if (this.state.phase !== 'BATTLE') return null;
    if (this.state.currentPlayer !== this.myId) return null;

    const result = processAttack(this.state, this.myId!, row, col);
    if (!result) return null;

    this.state.processing = true;
    this.send({ type: 'attack', playerId: this.myId!, row, col });

    if (this.state.winner) {
      this.state.phase = 'WIN';
    } else {
      this.state.currentPlayer = this.state.currentPlayer === 'p1' ? 'p2' : 'p1';
    }

    this.state.processing = false;
    if (this.myId === 'p1') this.emitState();
    this.onStateChange?.(this.state);
    return result;
  }

  requestRematch() {
    this.send({ type: 'rematch', playerId: this.myId! });
    this.state = this.freshState();
    this.state.phase = 'PLACE_P1';
    this.onStateChange?.(this.state);
  }

  sendChat(text: string) {
    this.send({ type: 'chat', playerId: this.myId!, text });
  }

  disconnect() {
    this.transport?.disconnect();
    this.transport = null;
    this.connected = false;
    this.myId = null;
    this.room = '';
    this.opponentReady = false;
    this.state = this.freshState();
  }
}

export { SHIPS_COUNT, GRID, getShipCells, isValidPlacement, freshPlayer };
