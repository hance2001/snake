"use strict";

const socket = io();
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const nameInput = document.getElementById('name');
const joinButton = document.getElementById('join');
const overlayEl = document.getElementById('overlay');
const scoreBody = document.getElementById('score-body');
const logList = document.getElementById('log');

let currentState = null;
let playerId = null;
let joinPending = false;
let lastDeath = null;
let isConnected = false;

const logLines = [];
const MAX_LOG_LINES = 9;
const keyMap = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  W: 'up',
  s: 'down',
  S: 'down',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
};

joinButton.addEventListener('click', requestJoin);
nameInput.addEventListener('input', handleNameInput);
nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    requestJoin();
  }
  if (event.key === 'Escape') {
    nameInput.value = '';
    nameInput.blur();
  }
});

document.addEventListener('keydown', handleKeydown);
window.addEventListener('resize', () => {
  if (currentState?.grid) {
    syncCanvasSize(currentState.grid);
    render();
  }
});

socket.on('connect', () => {
  isConnected = true;
  appendLog('SYS: LINK ESTABLISHED.');
  updateStatus('CONNECTED // PRESS ENTER TO JOIN');
  updateJoinButton();
  updateOverlay();
});

socket.on('disconnect', () => {
  isConnected = false;
  joinPending = false;
  appendLog('SYS: CONNECTION LOST. RETRYING...');
  updateStatus('CONNECTION LOST // RETRYING');
  updateJoinButton();
  updateOverlay();
});

socket.on('state', (state) => {
  currentState = state;
  if (state?.grid) {
    syncCanvasSize(state.grid);
  }
  updateScoreboard();
  render();
});

socket.on('joinAcknowledged', (payload) => {
  playerId = payload?.id ?? playerId;
  joinPending = false;
  lastDeath = null;
  appendLog('SYS: ENTRY GRANTED.');
  updateStatus('IN ARENA // GOOD LUCK');
  updateJoinButton();
  updateOverlay();
});

socket.on('joinError', (payload = {}) => {
  joinPending = false;
  const message = payload.message ? payload.message.toUpperCase() : 'JOIN REJECTED';
  appendLog(`ERR: ${message}`);
  updateStatus(`JOIN FAILED // ${message}`);
  updateJoinButton();
  updateOverlay();
});

socket.on('killed', (payload = {}) => {
  lastDeath = (payload.reason || 'collision').toUpperCase();
  joinPending = false;
  appendLog(`SYS: ELIMINATED (${lastDeath}).`);
  updateStatus(`ELIMINATED // ${lastDeath}`);
  updateJoinButton();
  updateOverlay();
});

socket.on('announcement', (payload = {}) => {
  if (!payload.message) {
    return;
  }
  appendLog(`MSG: ${payload.message}`);
});

function requestJoin() {
  if (!isConnected || joinPending) {
    return;
  }
  joinPending = true;
  updateStatus('JOINING...');
  updateJoinButton();
  socket.emit('join', { name: nameInput.value.trim() });
  updateOverlay();
}

function handleKeydown(event) {
  const direction = keyMap[event.key];
  if (direction) {
    event.preventDefault();
    sendDirection(direction);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    requestJoin();
  }
}

function handleNameInput(event) {
  const cleaned = event.target.value.toUpperCase().replace(/[^A-Z0-9\s-]/g, '');
  event.target.value = cleaned;
}

function sendDirection(direction) {
  const player = getSelf();
  if (!player?.alive || joinPending) {
    return;
  }
  socket.emit('input', { direction });
}

function getSelf() {
  if (!playerId || !currentState?.players) {
    return null;
  }
  return currentState.players.find((player) => player.id === playerId) || null;
}

function syncCanvasSize(grid) {
  const width = grid.cols * grid.cellSize;
  const height = grid.rows * grid.cellSize;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function render() {
  if (!ctx || !currentState?.grid) {
    return;
  }

  const { grid, food = [], players = [] } = currentState;
  const width = grid.cols * grid.cellSize;
  const height = grid.rows * grid.cellSize;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawBackground(grid);
  drawFood(food, grid.cellSize);
  drawPlayers(players, grid.cellSize);
  updateOverlay();
}

function drawBackground(grid) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 255, 120, 0.12)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= grid.cols; x += 1) {
    const px = x * grid.cellSize + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= grid.rows; y += 1) {
    const py = y * grid.cellSize + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(canvas.width, py);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFood(food, cellSize) {
  ctx.save();
  food.forEach((item) => {
    const pad = Math.max(1, Math.floor(cellSize * 0.2));
    const x = item.x * cellSize + pad;
    const y = item.y * cellSize + pad;
    const size = cellSize - pad * 2;
    ctx.fillStyle = '#eaff4b';
    ctx.shadowColor = '#f8ff9a';
    ctx.shadowBlur = 12;
    ctx.fillRect(x, y, size, size);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffcc';
    ctx.globalAlpha = 0.4;
    ctx.fillRect(x + size * 0.35, y + size * 0.35, size * 0.2, size * 0.2);
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

function drawPlayers(players, cellSize) {
  const sorted = [...players].sort((a, b) => {
    if (a.id === playerId && b.id !== playerId) {
      return 1;
    }
    if (b.id === playerId && a.id !== playerId) {
      return -1;
    }
    return 0;
  });
  sorted.forEach((player) => {
    if (!Array.isArray(player.snake) || player.snake.length === 0) {
      return;
    }
    ctx.save();
    ctx.fillStyle = player.color || '#66ff99';
    ctx.shadowColor = player.color || '#66ff99';
    ctx.shadowBlur = player.id === playerId ? 16 : 8;
    ctx.globalAlpha = player.alive ? 0.95 : 0.35;
    player.snake.forEach((segment, index) => {
      const x = segment.x * cellSize;
      const y = segment.y * cellSize;
      const pad = index === 0 ? Math.max(1, Math.floor(cellSize * 0.1)) : Math.max(1, Math.floor(cellSize * 0.22));
      const size = cellSize - pad * 2;
      ctx.fillRect(x + pad, y + pad, size, size);
    });
    ctx.restore();
  });
}

function updateScoreboard() {
  if (!scoreBody) {
    return;
  }
  const players = currentState?.players || [];
  if (players.length === 0) {
    scoreBody.innerHTML = '<tr><td colspan="4">NO PILOTS ONLINE</td></tr>';
    return;
  }

  const rows = [...players]
    .sort((a, b) => {
      const lenA = Array.isArray(a.snake) ? a.snake.length : 0;
      const lenB = Array.isArray(b.snake) ? b.snake.length : 0;
      if (lenA !== lenB) {
        return lenB - lenA;
      }
      return (b.best || 0) - (a.best || 0);
    })
    .map((player, index) => {
      const len = Array.isArray(player.snake) ? player.snake.length : 0;
      const best = player.best || len;
      const classes = ['score-row'];
      if (player.id === playerId) {
        classes.push('self');
      }
      if (!player.alive) {
        classes.push('down');
      }
      const color = player.color || '#66ff99';
      return `<tr class="${classes.join(' ')}"><td>${index + 1}</td><td><span class="color-chip" style="background:${color}"></span>${escapeHtml(player.name || 'UNKNOWN')}</td><td>${len}</td><td>${best}</td></tr>`;
    })
    .join('');

  scoreBody.innerHTML = rows;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  logLines.push(`[${timestamp}] ${message}`);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.shift();
  }
  logList.innerHTML = logLines
    .slice()
    .reverse()
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
}

function updateStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function updateJoinButton() {
  if (!joinButton) {
    return;
  }
  joinButton.disabled = !isConnected || joinPending;
  joinButton.textContent = joinPending ? 'JOINING...' : 'JOIN';
}

function updateOverlay() {
  if (!overlayEl) {
    return;
  }
  if (!isConnected) {
    overlayEl.textContent = 'LINK DOWN // WAITING';
    overlayEl.classList.remove('hidden');
    return;
  }
  if (joinPending) {
    overlayEl.textContent = 'AUTHORIZING...';
    overlayEl.classList.remove('hidden');
    return;
  }
  const self = getSelf();
  if (self?.alive) {
    overlayEl.textContent = '';
    overlayEl.classList.add('hidden');
    return;
  }
  overlayEl.textContent = lastDeath ? `ELIMINATED // ${lastDeath}` : 'PRESS ENTER TO JOIN';
  overlayEl.classList.remove('hidden');
}

function escapeHtml(value) {
  return value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
