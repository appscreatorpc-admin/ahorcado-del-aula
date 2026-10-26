// Ahorcado del Aula — servidor multijugador
// Node.js + Express + Socket.io
//
// Un servidor puede alojar varias "salas" en paralelo (varios grupos
// jugando al mismo tiempo, cada uno con su propio código de sala). El
// estado vive en memoria: se reinicia si el servidor se reinicia. Para
// una clase esto es suficiente y evita depender de una base de datos.
//
// Cambios de esta versión (a partir de lo que reportó el profesor):
//  - Los equipos se identifican por NOMBRE, no por dispositivo. Si varios
//    alumnos del mismo equipo entran cada uno desde su celular con el
//    mismo nombre de equipo, comparten un solo marcador (antes cada
//    celular creaba un equipo nuevo con 0 puntos, por eso parecía que no
//    se acumulaban).
//  - Mientras un equipo tiene el timbre y sigue acertando letras, NO se
//    le quita el turno — puede seguir intentando hasta que falle. Solo
//    entonces se libera el timbre para los demás.
//  - Si se acaban los intentos sin que nadie complete la palabra, gana
//    la ronda el equipo que más letras correctas haya aportado en esa
//    ronda (en vez de que nadie gane).
//  - El anfitrión puede abrir/cerrar el timbre a voluntad (para que
//    nadie pueda tocarlo mientras explica o escribe), además de poder
//    liberar al equipo que lo esté deteniendo.
//  - El anfitrión prepara TODAS las palabras y pistas de la partida
//    desde la pantalla inicial (una por ronda), en vez de escribirlas
//    ronda por ronda. Esas palabras nunca se envían a los equipos por
//    adelantado — solo al anfitrión, en la respuesta directa a sus
//    propias acciones.
//  - Al terminar el juego se guarda un desglose: qué palabra tuvo cada
//    ronda, quién la ganó y por qué.

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
const ROUND_WIN_BONUS = 30; // por completar la palabra letra por letra
const WORD_GUESS_BONUS = 50; // por adivinar la palabra completa de un tiro
const MOST_CORRECT_BONUS = 15; // por ganar la ronda al tener más aciertos cuando se agotan los intentos
const BUZZ_TIMEOUT_MS = 15000; // tiempo para responder tras tocar el timbre (se reinicia con cada acierto)
const HOST_GRACE_MS = 10 * 60 * 1000; // minutos de gracia si el anfitrion se desconecta
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
const MAX_ROUNDS = 20;

/** @type {Map<string, Room>} */
const rooms = new Map();

const REASON_LABELS = {
  completed_letters: 'completó la palabra letra por letra',
  guessed_word: 'adivinó la palabra completa de un tiro',
  most_correct: 'tuvo más aciertos cuando se acabaron los intentos',
  nobody: 'nadie acertó ninguna letra',
};

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeTeamKey(name) {
  return stripAccents((name || '').trim().toLowerCase()).replace(/\s+/g, ' ');
}

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeRoundPlan(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const clean = list.map((r) => {
    const word = ((r && r.word) || '').toUpperCase().trim();
    const hint = ((r && r.hint) || '').trim();
    const maxAttempts = Math.min(Math.max(parseInt(r && r.maxAttempts, 10) || 6, 3), 10);
    return { word, hint, maxAttempts };
  });
  return clean;
}

function validateRoundPlan(plan) {
  if (!plan.length) return 'Agrega al menos una ronda.';
  if (plan.length > MAX_ROUNDS) return `Como máximo ${MAX_ROUNDS} rondas.`;
  for (let i = 0; i < plan.length; i++) {
    const lettersOnly = plan[i].word.replace(/[^A-ZÀ-ÿÑ]/gi, '');
    if (lettersOnly.length < 2) return `La ronda ${i + 1} necesita una palabra de al menos 2 letras.`;
    if (!plan[i].hint) return `La ronda ${i + 1} necesita una pista.`;
  }
  return null;
}

function createRoom(roundPlan) {
  const code = generateRoomCode();
  const room = {
    code,
    hostToken: crypto.randomBytes(12).toString('hex'),
    hostSocketId: null,
    roundsPlan: roundPlan, // nunca se transmite por broadcast; solo en respuestas directas al anfitrión
    totalRounds: roundPlan.length,
    round: 0, // número de ronda actualmente jugada o terminada (0 = ninguna empezada)
    status: 'lobby', // lobby -> playing -> round_end -> (lobby | game_end)
    word: '',
    hint: '',
    maxAttempts: 6,
    wrongCount: 0,
    guessedBase: new Set(),
    wrongLetters: [],
    teams: new Map(), // teamKey -> { name, score, members: Set<socketId> }
    buzzer: null, // { teamKey, teamName, timer }
    buzzerOpen: true, // compuerta manual del anfitrión
    roundCorrectCounts: new Map(), // teamKey -> aciertos de letra en la ronda actual
    roundWinnerName: null,
    roundWinReason: null,
    roundsHistory: [], // { round, word, hint, winnerName, reason, points }
  };
  rooms.set(code, room);
  return room;
}

function openBuzzer(room) {
  if (room.buzzer && room.buzzer.timer) clearTimeout(room.buzzer.timer);
  room.buzzer = null;
}

function armBuzzTimeout(room, teamKey) {
  if (room.buzzer && room.buzzer.timer) clearTimeout(room.buzzer.timer);
  room.buzzer.timer = setTimeout(() => {
    if (room.buzzer && room.buzzer.teamKey === teamKey) {
      openBuzzer(room);
      broadcast(room);
    }
  }, BUZZ_TIMEOUT_MS);
}

function wordIsComplete(room) {
  return room.word.split('').every((ch) => {
    if (ch === ' ' || ch === '-') return true;
    return room.guessedBase.has(stripAccents(ch));
  });
}

function addRoundHistory(room, winnerName, reason, points) {
  room.roundsHistory.push({
    round: room.round,
    word: room.word,
    hint: room.hint,
    winnerName: winnerName || null,
    reason,
    points,
  });
}

function finishRoundByExhaustion(room) {
  // Nadie completó la palabra: gana quien tuvo más aciertos de letra en la ronda.
  let bestKey = null;
  let bestCount = 0;
  let tie = false;
  room.roundCorrectCounts.forEach((count, key) => {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
      tie = false;
    } else if (count === bestCount && count > 0) {
      tie = true;
    }
  });

  room.status = 'round_end';
  if (bestKey && !tie && bestCount > 0) {
    const team = room.teams.get(bestKey);
    team.score += MOST_CORRECT_BONUS;
    room.roundWinnerName = team.name;
    room.roundWinReason = 'most_correct';
    addRoundHistory(room, team.name, 'most_correct', MOST_CORRECT_BONUS);
  } else {
    room.roundWinnerName = null;
    room.roundWinReason = 'nobody';
    addRoundHistory(room, null, 'nobody', 0);
  }
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
    .map(([key, t]) => ({ id: key, name: t.name, score: t.score, connected: t.members.size > 0 }))
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
    buzzer: room.buzzer ? { teamId: room.buzzer.teamKey, teamName: room.buzzer.teamName } : null,
    buzzerOpen: room.buzzerOpen,
    revealedWord: revealAll ? room.word : null,
    roundWinnerName: room.status === 'round_end' ? room.roundWinnerName : null,
    roundWinReason: room.status === 'round_end' ? room.roundWinReason : null,
    roundsHistory: room.status === 'game_end' ? room.roundsHistory : [],
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
  if (!room || !room.teams.has(socket.data.teamKey)) return null;
  return room;
}

io.on('connection', (socket) => {
  // ---------- Anfitrion ----------

  socket.on('host:createRoom', ({ rounds } = {}, cb) => {
    const plan = sanitizeRoundPlan(rounds);
    const error = validateRoundPlan(plan);
    if (error) return cb && cb({ ok: false, error });

    const room = createRoom(plan);
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;

    cb && cb({
      ok: true,
      roomCode: room.code,
      hostToken: room.hostToken,
      totalRounds: room.totalRounds,
      nextRoundPlan: room.roundsPlan[0],
    });
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

    const nextPlan = room.status === 'lobby' && room.round < room.totalRounds ? room.roundsPlan[room.round] : null;

    cb && cb({
      ok: true,
      roomCode: room.code,
      hostToken: room.hostToken,
      totalRounds: room.totalRounds,
      nextRoundPlan: nextPlan,
    });
    broadcast(room);
  });

  socket.on('host:startRound', ({ word, hint, maxAttempts } = {}, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'No autorizado.' });
    if (room.status === 'playing') return cb && cb({ ok: false, error: 'Ya hay una ronda en curso.' });
    if (room.round >= room.totalRounds && room.status !== 'lobby') {
      return cb && cb({ ok: false, error: 'Ya se jugaron todas las rondas.' });
    }

    // Usa lo que mande el anfitrión (por si editó el campo a último momento);
    // si no manda nada, cae en lo planeado desde la creación de la sala.
    const planned = room.roundsPlan[room.round] || {};
    const clean = ((word !== undefined ? word : planned.word) || '').toUpperCase().trim();
    const lettersOnly = clean.replace(/[^A-ZÀ-ÿÑ]/gi, '');
    if (lettersOnly.length < 2) return cb && cb({ ok: false, error: 'La palabra necesita al menos 2 letras.' });
    const cleanHint = (hint !== undefined ? hint : planned.hint || '').trim();
    if (!cleanHint) return cb && cb({ ok: false, error: 'Agrega una pista.' });

    openBuzzer(room);
    room.word = clean;
    room.hint = cleanHint;
    room.maxAttempts = Math.min(Math.max(parseInt(maxAttempts !== undefined ? maxAttempts : planned.maxAttempts, 10) || 6, 3), 10);
    room.wrongCount = 0;
    room.guessedBase = new Set();
    room.wrongLetters = [];
    room.status = 'playing';
    room.buzzerOpen = true;
    room.roundWinnerName = null;
    room.roundWinReason = null;
    room.roundCorrectCounts = new Map();
    room.round += 1;

    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('host:nextRound', (_data, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false });
    openBuzzer(room);
    if (room.round >= room.totalRounds) {
      room.status = 'game_end';
      cb && cb({ ok: true, gameEnded: true });
    } else {
      room.status = 'lobby';
      cb && cb({ ok: true, gameEnded: false, nextRoundPlan: room.roundsPlan[room.round] });
    }
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

  socket.on('host:setBuzzerOpen', ({ open } = {}, cb) => {
    const room = getHostRoom(socket);
    if (!room) return cb && cb({ ok: false });
    room.buzzerOpen = !!open;
    if (!room.buzzerOpen) openBuzzer(room); // si lo cierra, también suelta a quien lo tuviera
    cb && cb({ ok: true });
    broadcast(room);
  });

  // ---------- Equipos ----------

  socket.on('team:join', ({ roomCode, teamName } = {}, cb) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'Código de sala no encontrado.' });

    const name = (teamName || '').trim().slice(0, 24);
    if (!name) return cb && cb({ ok: false, error: 'Escribe el nombre de tu equipo.' });
    const key = normalizeTeamKey(name);
    if (!key) return cb && cb({ ok: false, error: 'Escribe el nombre de tu equipo.' });

    let team = room.teams.get(key);
    if (!team) {
      team = { name, score: 0, members: new Set() };
      room.teams.set(key, team);
    }
    team.members.add(socket.id);

    socket.join(room.code);
    socket.data.role = 'team';
    socket.data.roomCode = room.code;
    socket.data.teamKey = key;

    cb && cb({ ok: true, roomCode: room.code, teamId: key, teamName: team.name });
    broadcast(room);
  });

  socket.on('team:buzz', (_data, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false, error: 'No estás en una sala activa.' });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'Todavía no hay una ronda activa.' });
    if (!room.buzzerOpen) return cb && cb({ ok: false, error: 'El anfitrión cerró el timbre por ahora.' });
    if (room.buzzer) return cb && cb({ ok: false, error: 'Otro equipo se adelantó.' });

    const team = room.teams.get(socket.data.teamKey);
    room.buzzer = { teamKey: socket.data.teamKey, teamName: team.name, timer: null };
    armBuzzTimeout(room, socket.data.teamKey);

    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('team:guessLetter', ({ letter } = {}, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'No hay ronda activa.' });
    if (!room.buzzer || room.buzzer.teamKey !== socket.data.teamKey) {
      return cb && cb({ ok: false, error: 'No tienes el turno.' });
    }

    const L = (letter || '').toUpperCase();
    if (!LETTERS.includes(L)) return cb && cb({ ok: false, error: 'Letra inválida.' });
    const base = stripAccents(L);
    if (room.guessedBase.has(base) || room.wrongLetters.includes(L)) {
      return cb && cb({ ok: false, error: 'Esa letra ya se usó.' });
    }

    const team = room.teams.get(socket.data.teamKey);
    const isHit = stripAccents(room.word).includes(base);

    if (isHit) {
      room.guessedBase.add(base);
      team.score += POINTS_PER_LETTER;
      room.roundCorrectCounts.set(socket.data.teamKey, (room.roundCorrectCounts.get(socket.data.teamKey) || 0) + 1);

      if (wordIsComplete(room)) {
        team.score += ROUND_WIN_BONUS;
        openBuzzer(room);
        room.status = 'round_end';
        room.roundWinnerName = team.name;
        room.roundWinReason = 'completed_letters';
        addRoundHistory(room, team.name, 'completed_letters', POINTS_PER_LETTER + ROUND_WIN_BONUS);
      } else {
        // Sigue acertando: mantiene el turno, pero se le renueva el tiempo para la siguiente letra.
        armBuzzTimeout(room, socket.data.teamKey);
      }
    } else {
      room.wrongCount += 1;
      room.wrongLetters.push(L);
      openBuzzer(room); // se equivocó: libera el timbre para los demás
      if (room.wrongCount >= room.maxAttempts) {
        finishRoundByExhaustion(room);
      }
    }

    cb && cb({ ok: true, correct: isHit });
    broadcast(room);
  });

  socket.on('team:guessWord', ({ word } = {}, cb) => {
    const room = getTeamRoom(socket);
    if (!room) return cb && cb({ ok: false });
    if (room.status !== 'playing') return cb && cb({ ok: false, error: 'No hay ronda activa.' });
    if (!room.buzzer || room.buzzer.teamKey !== socket.data.teamKey) {
      return cb && cb({ ok: false, error: 'No tienes el turno.' });
    }

    const attempt = stripAccents((word || '').toUpperCase().trim());
    if (!attempt) return cb && cb({ ok: false, error: 'Escribe una palabra.' });

    const team = room.teams.get(socket.data.teamKey);
    const target = stripAccents(room.word);

    if (attempt === target) {
      room.word.split('').forEach((ch) => {
        if (ch !== ' ' && ch !== '-') room.guessedBase.add(stripAccents(ch));
      });
      team.score += WORD_GUESS_BONUS;
      openBuzzer(room);
      room.status = 'round_end';
      room.roundWinnerName = team.name;
      room.roundWinReason = 'guessed_word';
      addRoundHistory(room, team.name, 'guessed_word', WORD_GUESS_BONUS);
      cb && cb({ ok: true, correct: true });
    } else {
      room.wrongCount += 1;
      openBuzzer(room); // fallo de palabra completa: también libera el timbre, igual que una letra
      if (room.wrongCount >= room.maxAttempts) {
        finishRoundByExhaustion(room);
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
      const team = room.teams.get(socket.data.teamKey);
      if (team) team.members.delete(socket.id);
      if (room.buzzer && room.buzzer.teamKey === socket.data.teamKey && team && team.members.size === 0) {
        openBuzzer(room);
      }
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
