const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const TICK_INTERVAL = 110;
const GRID_COLS = 40;
const GRID_ROWS = 30;
const CELL_SIZE = 18;
const INITIAL_LENGTH = 4;
const FOOD_TARGET = 5;
const MAX_SPAWN_ATTEMPTS = 120;

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const COLOR_PALETTE = [
  '#00ff41',
  '#00d3ff',
  '#ff00a0',
  '#ff9900',
  '#fffb00',
  '#ff3500',
  '#9f00ff',
  '#00ff9c',
];

const HANDLE_PREFIXES = [
  'SYS',
  'DOS',
  'HEX',
  'CMD',
  'CRT',
  'IO',
  'NUL',
  'BIN',
];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const players = new Map();
const foods = [];
let colorCursor = 0;

app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('state', buildPublicState());

  socket.on('join', (payload) => handleJoin(socket, payload));
  socket.on('input', (payload) => handleInput(socket, payload));
  socket.on('setName', (payload) => handleSetName(socket, payload));

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      players.delete(socket.id);
      io.emit('announcement', { message: `${player.name} left the arena.` });
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

ensureFood();
setInterval(tick, TICK_INTERVAL);

function tick() {
  ensureFood();

  const liveMoves = Array.from(players.values())
    .filter((player) => player.alive)
    .map((player) => createMove(player));

  if (liveMoves.length === 0) {
    broadcastState();
    return;
  }

  const bodyOccupancy = buildBodyOccupancy();
  const moveById = new Map(liveMoves.map((move) => [move.player.id, move]));

  liveMoves.forEach((move) => {
    if (move.dead) return;
    const { x, y } = move.nextHead;
    if (x < 0 || x >= GRID_COLS || y < 0 || y >= GRID_ROWS) {
      move.dead = true;
      move.reason = 'wall';
    }
  });

  liveMoves.forEach((move) => {
    if (move.dead) return;
    const key = posKey(move.nextHead);
    const occupant = bodyOccupancy.get(key);
    if (!occupant) return;

    const occupantPlayer = players.get(occupant.playerId);
    const occupantMove = moveById.get(occupant.playerId);
    const isTail = occupantPlayer && occupant.index === occupantPlayer.snake.length - 1;
    const occupantWillVacate =
      occupantMove &&
      !occupantMove.dead &&
      !occupantMove.willEat &&
      isTail;

    if (occupant.playerId === move.player.id && occupantWillVacate) {
      return;
    }

    if (occupant.playerId !== move.player.id && occupantWillVacate) {
      return;
    }

    move.dead = true;
    move.reason = 'body';
  });

  const headOccupancy = new Map();
  liveMoves.forEach((move) => {
    if (move.dead) return;
    const key = posKey(move.nextHead);
    headOccupancy.set(key, (headOccupancy.get(key) || 0) + 1);
  });

  headOccupancy.forEach((count, key) => {
    if (count < 2) return;
    liveMoves.forEach((move) => {
      if (posKey(move.nextHead) === key) {
        move.dead = true;
        move.reason = 'head';
      }
    });
  });

  liveMoves.forEach((move) => {
    const { player } = move;
    if (move.dead) {
      killPlayer(player, move.reason || 'collision');
      return;
    }

    player.direction = move.direction;
    player.pendingDirection = move.direction;
    player.snake.unshift(move.nextHead);

    if (move.willEat) {
      player.score += 1;
      player.best = Math.max(player.best, player.snake.length);
      const foodIndex = foods.findIndex((food) => food.x === move.nextHead.x && food.y === move.nextHead.y);
      if (foodIndex !== -1) {
        foods.splice(foodIndex, 1);
      }
    } else {
      player.snake.pop();
    }
  });

  ensureFood();
  broadcastState();
}

function createMove(player) {
  const direction = chooseDirection(player);
  const head = player.snake[0];
  const nextHead = { x: head.x + direction.x, y: head.y + direction.y };
  const willEat = foods.some((food) => food.x === nextHead.x && food.y === nextHead.y);

  return {
    player,
    direction,
    nextHead,
    willEat,
    dead: false,
    reason: null,
  };
}

function chooseDirection(player) {
  if (!player.pendingDirection) {
    return player.direction || DIRECTIONS.right;
  }
  if (!player.direction) {
    return player.pendingDirection;
  }
  return isOpposite(player.direction, player.pendingDirection) ? player.direction : player.pendingDirection;
}

function buildBodyOccupancy() {
  const map = new Map();
  players.forEach((player) => {
    if (!player.alive) return;
    player.snake.forEach((segment, index) => {
      map.set(posKey(segment), { playerId: player.id, index });
    });
  });
  return map;
}

function handleJoin(socket, payload) {
  const requestedName = payload && typeof payload.name === 'string' ? payload.name : '';
  let player = players.get(socket.id);
  const safeName = sanitizeName(requestedName);

  if (!player) {
    player = createPlayer(socket, safeName);
  } else {
    player.socket = socket;
    if (safeName) {
      player.name = safeName;
    }
  }

  if (player.alive) {
    socket.emit('joinAcknowledged', { id: player.id, color: player.color });
    return;
  }

  const spawned = spawnPlayer(player);
  if (!spawned) {
    socket.emit('joinError', { message: 'No space to spawn. Try again soon.' });
    return;
  }

  player.score = 0;
  player.best = Math.max(player.best, player.snake.length);
  socket.emit('joinAcknowledged', { id: player.id, color: player.color });
  io.emit('announcement', { message: `${player.name} joined the arena.` });
}

function handleInput(socket, payload) {
  const player = players.get(socket.id);
  if (!player || !player.alive) {
    return;
  }

  const directionKey = payload && payload.direction;
  const nextDirection = DIRECTIONS[directionKey];
  if (!nextDirection) {
    return;
  }

  if (player.direction && isOpposite(player.direction, nextDirection)) {
    return;
  }

  player.pendingDirection = nextDirection;
  player.lastInputAt = Date.now();
}

function handleSetName(socket, payload) {
  const player = players.get(socket.id);
  if (!player) {
    return;
  }
  const safeName = sanitizeName(payload && payload.name ? payload.name : '');
  if (!safeName) {
    return;
  }
  player.name = safeName;
  socket.emit('nameAccepted', { name: player.name });
}

function createPlayer(socket, safeName) {
  const name = safeName || randomName();
  const player = {
    id: socket.id,
    socket,
    name,
    color: nextColor(),
    alive: false,
    snake: [],
    direction: null,
    pendingDirection: null,
    score: 0,
    best: INITIAL_LENGTH,
    deaths: 0,
    createdAt: Date.now(),
    lastInputAt: 0,
  };
  players.set(socket.id, player);
  return player;
}

function spawnPlayer(player) {
  const occupied = getOccupiedSet();
  const directionKeys = Object.keys(DIRECTIONS);
  for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt += 1) {
    const directionKey = randomChoice(directionKeys);
    const direction = DIRECTIONS[directionKey];
    const head = { x: randomInt(GRID_COLS), y: randomInt(GRID_ROWS) };
    const snake = [];
    let valid = true;

    for (let i = 0; i < INITIAL_LENGTH; i += 1) {
      const x = head.x - direction.x * i;
      const y = head.y - direction.y * i;
      if (x < 0 || x >= GRID_COLS || y < 0 || y >= GRID_ROWS) {
        valid = false;
        break;
      }
      if (occupied.has(`${x},${y}`)) {
        valid = false;
        break;
      }
      snake.push({ x, y });
    }

    if (!valid) {
      continue;
    }

    player.snake = snake;
    player.direction = direction;
    player.pendingDirection = direction;
    player.alive = true;
    player.score = 0;
    player.spawnedAt = Date.now();
    return true;
  }

  return false;
}

function killPlayer(player, reason = 'collision') {
  if (!player.alive) {
    return;
  }
  player.alive = false;
  player.snake = [];
  player.direction = null;
  player.pendingDirection = null;
  player.score = 0;
  player.deaths += 1;
  player.socket?.emit('killed', { reason });
  io.emit('announcement', { message: `${player.name} was eliminated (${reason}).` });
}

function ensureFood() {
  while (foods.length < FOOD_TARGET) {
    const food = spawnFood();
    if (!food) {
      break;
    }
    foods.push(food);
  }
}

function spawnFood() {
  const occupied = getOccupiedSet();
  const totalCells = GRID_COLS * GRID_ROWS;
  for (let attempt = 0; attempt < totalCells; attempt += 1) {
    const x = randomInt(GRID_COLS);
    const y = randomInt(GRID_ROWS);
    if (occupied.has(`${x},${y}`)) {
      continue;
    }
    return { x, y };
  }
  return null;
}

function getOccupiedSet() {
  const set = new Set();
  players.forEach((player) => {
    if (!player.alive) {
      return;
    }
    player.snake.forEach((segment) => {
      set.add(posKey(segment));
    });
  });
  foods.forEach((food) => {
    set.add(posKey(food));
  });
  return set;
}



function broadcastState() {
  io.emit('state', buildPublicState());
}

function buildPublicState() {
  return {
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cellSize: CELL_SIZE },
    food: foods.map((food) => ({ x: food.x, y: food.y })),
    players: Array.from(players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      alive: player.alive,
      snake: player.snake.map((segment) => ({ x: segment.x, y: segment.y })), 
      score: player.score,
      best: player.best,
      deaths: player.deaths,
    })),
  };
}

function sanitizeName(name) {
  if (!name) {
    return '';
  }
  return name
    .toString()
    .replace(/[^A-Z0-9\s-]/gi, '')
    .trim()
    .slice(0, 16)
    .toUpperCase();
}

function randomName() {
  const prefix = randomChoice(HANDLE_PREFIXES);
  const suffix = randomInt(900) + 100;
  return `${prefix}${suffix}`;
}

function randomChoice(collection) {
  const array = Array.isArray(collection) ? collection : Object.keys(collection);
  return array[randomInt(array.length)];
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function nextColor() {
  const color = COLOR_PALETTE[colorCursor % COLOR_PALETTE.length];
  colorCursor += 1;
  return color;
}

function posKey(point) {
  return `${point.x},${point.y}`;
}

function isOpposite(a, b) {
  return a && b && a.x + b.x === 0 && a.y + b.y === 0;
}





