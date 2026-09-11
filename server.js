// Ahorcado del Aula — servidor multijugador
// Node.js + Express + Socket.io
//
// Un servidor puede alojar varias "salas" en paralelo (por ejemplo, varios
// grupos jugando al mismo tiempo, cada uno con su propio codigo de sala).
// El estado del juego vive en memoria: se reinicia si el servidor se
// reinicia. Para una clase esto es suficiente y evita depender de una
// base de datos externa.

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const LETTERS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.split('');
const POINTS_PER_LETTER = 10;
const ROUND_WIN_BONUS = 30;
const WORD_GUESS_BONUS = 50;
const BUZZ_TIMEOUT_MS = 15000; // tiempo para responder tras tocar el timbre
const HOST_GRACE_MS = 10 * 60 * 1000; // minutos de gracia si el anfitrion se desconecta
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos

/** @type {Map<string, Room>} */
const rooms = new Map();

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(totalRounds) {
  const code = generateRoomCode();
  const room = {
    code,
    hostToken: crypto.randomBytes(12).toString('hex'),
    hostSocketId: null,
    totalRounds,
    round: 0,
    status: 'lobby', // lobby -> playing -> round_end -> (lobby | game_end)
    word: '',
    hint: '',
    maxAttempts: 6,
    wrongCount: 0,
    guessedBase: new Set(),
    wrongLetters: [],
    teams: new Map(), // teamId -> { name, score, socketId, connected }
    buzzer: null, // { teamId, teamName, timer }
    roundWinnerName: null, // nombre del equipo que ganó la ronda, o null si nadie acertó
  };
  rooms.set(code, room);
  return room;
}

function openBuzzer(room) {
  if (room.buzzer && room.buzzer.timer) clearTimeout(room.buzzer.timer);
  room.buzzer = null;
}

function wordIsComplete(room) {
  return room.word.split('').every((ch) => {
    if (ch === ' ' || ch === '-') return true;
    return room.guessedBase.has(stripAccents(ch));
  });
}

function publicState(room) {
  const revealAll = room.status === 'round_end' || room.status === 'game_end';
  const wordDisplay = room.word
    ? room.word.split('').map((ch) => {
        if (ch === ' ') return { type: 'space' };
        if (ch === '-') return { type: 'dash', value: '-' };
        const base = stripAccents(ch);
        const revealed = revealAll || room.guessedBase.has(base);
        return { type: 'letter', value: revealed ? ch : null };
      })
    : [];

  const teams = Array.from(room.teams.entries())
    .map(([id, t]) => ({ id, name: t.name, score: t.score, connected: t.connected }))
    .sort((a, b) => b.score - a.score);

  let winners = null;
  if (room.status === 'game_end' && teams.length) {
    const top = teams[0].score;
    winners = teams.filter((t) => t.score === top).map((t) => t.name);
  }

  return {
    code: room.code,
    round: room.round,
    totalRounds: room.totalRounds,
    status: room.status,
    hint: room.hint,
    wordDisplay,
    maxAttempts: room.maxAttempts,
    wrongCount: room.wrongCount,
    wrongLetters: room.wrongLetters,
    teams,
    buzzer: room.buzzer ? { teamId: room.buzzer.teamId, teamName: room.buzzer.teamName } : null,
    revealedWord: revealAll ? room.word : null,
    roundWinnerName: room.status === 'round_end' ? room.roundWinnerName : null,
    winners,
    hostConnected: !!room.hostSocketId,
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function getHostRoom(socket) {
  const code = socket.data.roomCode;
  if (!code || socket.data.role !== 'host') return null;
  return rooms.get(code) || null;
}

function getTeamRoom(socket) {
  const code = socket.data.roomCode;
  if (!code || socket.data.role !== 'team') return null;
  const room = rooms.get(code);
  if (!room || !room.teams.has(socket.data.teamId)) return null;
  return room;
}

io.on('connection', (socket) => {
  // ---------- Anfitrion ----------

  socket.on('host:createRoom', ({ totalRounds } = {}, cb) => {
    const rounds = Math.min(Math.max(parseInt(totalRounds, 10) || 5, 1), 20);
    const room = createRoom(rounds);
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    cb && cb({ ok: true, roomCode: room.code, hostToken: room.hostToken });
    broadcast(room);
  });

  socket.on('host:rejoinRoom', ({ roomCode, hostToken } = {}, cb) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room || room.hostToken !== hostToken) {
      return cb && cb({ ok: false, error: 'No se encontró esa sala.' });
    }
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    cb && cb({ ok: true, roomCode: room.code, hostToken: room.hostToken });
    broadcast(room);
  });

  socket.on('host:startRound', ({ word, hint, maxAttempts } = {}, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'No autorizado.' });
    if (room.status === 'playing') return cb && cb({ ok: false, error: 'Ya hay una ronda en curso.' });
    if (room.round >= room.totalRounds && room.status !== 'lobby') {
      return cb && cb({ ok: false, error: 'Ya se jugaron todas las rondas.' });
    }
    const clean = (word || '').toUpperCase().trim();
    const lettersOnly = clean.replace(/[^A-ZÀ-ÿÑ]/gi, '');
    if (lettersOnly.length < 2) return cb && cb({ ok: false, error: 'La palabra necesita al menos 2 letras.' });
    if (!hint || !hint.trim()) return cb && cb({ ok: false, error: 'Agrega una pista.' });

    openBuzzer(room);
    room.word = clean;
    room.hint = hint.trim();
    room.maxAttempts = Math.min(Math.max(parseInt(maxAttempts, 10) || 6, 3), 10);
    room.wrongCount = 0;
    room.guessedBase = new Set();
    room.wrongLetters = [];
    room.status = 'playing';
    room.roundWinnerName = null;
    room.round += 1;
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('host:nextRound', (_data, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false });
    openBuzzer(room);
    room.status = room.round >= room.totalRounds ? 'game_end' : 'lobby';
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('host:endGame', (_data, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false });
    openBuzzer(room);
    room.status = 'game_end';
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('host:releaseBuzzer', (_data, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false });
    openBuzzer(room);
    cb && cb({ ok: true });
    broadcast(room);
  });

  // ---------- Equipos ----------

  socket.on('team:join', ({ roomCode, teamName, teamId } = {}, cb) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'Código de sala no encontrado.' });

    const name = (teamName || '').trim().slice(0, 24) || 'Equipo';
    const id = teamId && room.teams.has(teamId) ? teamId : (teamId || crypto.randomBytes(8).toString('hex'));

    const existing = room.teams.get(id);
    if (existing) {
      existing.name = name;
      existing.socketId = socket.id;
      existing.connected = true;
    } else {
      room.teams.set(id, { name, score: 0, socketId: socket.id, connected: true });
    }

    socket.join(room.code);
    socket.data.role = 'team';
    socket.data.roomCode = room.code;
    socket.data.teamId = id;

    cb && cb({ ok: true, roomCode: room.code, teamId: id, teamName: name });
    broadcast(room);
  });

  socket.on('team:buzz', (_data, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'No estás en una sala activa.' });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'Todavía no hay una ronda activa.' });
    if (room.buzzer) return cb && cb({ ok: false, error: 'Otro equipo se adelantó.' });

    const team = room.teams.get(socket.data.teamId);
    room.buzzer = { teamId: socket.data.teamId, teamName: team.name, timer: null };
    room.buzzer.timer = setTimeout(() => {
      if (room.buzzer && room.buzzer.teamId === socket.data.teamId) {
        openBuzzer(room);
        broadcast(room);
      }
    }, BUZZ_TIMEOUT_MS);

    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('team:guessLetter', ({ letter } = {}, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'No hay ronda activa.' });
    if (!room.buzzer || room.buzzer.teamId !== socket.data.teamId) {
      return cb && cb({ ok: false, error: 'No tienes el turno.' });
    }

    const L = (letter || '').toUpperCase();
    if (!LETTERS.includes(L)) return cb && cb({ ok: false, error: 'Letra inválida.' });
    const base = stripAccents(L);
    if (room.guessedBase.has(base) || room.wrongLetters.includes(L)) {
      return cb && cb({ ok: false, error: 'Esa letra ya se usó.' });
    }

    const team = room.teams.get(socket.data.teamId);
    const isHit = stripAccents(room.word).includes(base);

    openBuzzer(room);

    if (isHit) {
      room.guessedBase.add(base);
      team.score += POINTS_PER_LETTER;
      if (wordIsComplete(room)) {
        team.score += ROUND_WIN_BONUS;
        room.status = 'round_end';
        room.roundWinnerName = team.name;
      }
    } else {
      room.wrongCount += 1;
      room.wrongLetters.push(L);
      if (room.wrongCount >= room.maxAttempts) {
        room.status = 'round_end';
      }
    }

    cb && cb({ ok: true, correct: isHit });
    broadcast(room);
  });

  socket.on('team:guessWord', ({ word } = {}, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'No hay ronda activa.' });
    if (!room.buzzer || room.buzzer.teamId !== socket.data.teamId) {
      return cb && cb({ ok: false, error: 'No tienes el turno.' });
    }

    const attempt = stripAccents((word || '').toUpperCase().trim());
    if (!attempt) return cb && cb({ ok: false, error: 'Escribe una palabra.' });

    const team = room.teams.get(socket.data.teamId);
    const target = stripAccents(room.word);
    openBuzzer(room);

    if (attempt === target) {
      room.word.split('').forEach((ch) => {
        if (ch !== ' ' && ch !== '-') room.guessedBase.add(stripAccents(ch));
      });
      team.score += WORD_GUESS_BONUS;
      room.status = 'round_end';
      room.roundWinnerName = team.name;
      cb && cb({ ok: true, correct: true });
    } else {
      room.wrongCount += 1;
      if (room.wrongCount >= room.maxAttempts) {
        room.status = 'round_end';
      }
      cb && cb({ ok: true, correct: false });
    }

    broadcast(room);
  });

  // ---------- Desconexion ----------

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (socket.data.role === 'team') {
      const team = room.teams.get(socket.data.teamId);
      if (team && team.socketId === socket.id) team.connected = false;
      if (room.buzzer && room.buzzer.teamId === socket.data.teamId) openBuzzer(room);
      broadcast(room);
    }

    if (socket.data.role === 'host' && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      broadcast(room);
      setTimeout(() => {
        const stillThere = rooms.get(roomCode);
        if (stillThere && !stillThere.hostSocketId) rooms.delete(roomCode);
      }, HOST_GRACE_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ahorcado del Aula escuchando en el puerto ${PORT}`);
});
