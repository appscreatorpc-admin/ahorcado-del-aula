(function () {
  'use strict';

  var LETTERS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.split('');

  var REASON_LABELS = {
    completed_letters: 'completó la palabra letra por letra',
    guessed_word: 'adivinó la palabra completa de un tiro',
    most_correct: 'tuvo más aciertos cuando se acabaron los intentos',
    nobody: 'nadie acertó ninguna letra',
  };

  var socket = io();

  var role = null; // 'host' | 'team'
  var myTeamId = null;
  var latestState = null;
  var roundDrafts = []; // [{word, hint, maxAttempts}] — fuente de verdad del formulario inicial

  // ---------- Utilidades de pantalla ----------

  var screens = [
    'screen-role',
    'screen-host-setup',
    'screen-team-join',
    'screen-host-play',
    'screen-team-play',
  ];

  function showScreen(id) {
    screens.forEach(function (s) {
      var el = document.getElementById(s);
      if (el) el.hidden = s !== id;
    });
  }

  function showHostPanel(id) {
    ['hostPanelLobby', 'hostPanelPlaying', 'hostPanelRoundEnd', 'hostPanelGameEnd'].forEach(function (p) {
      var el = document.getElementById(p);
      if (el) el.hidden = p !== id;
    });
  }

  function showTeamPanel(id) {
    ['teamPanelLobby', 'teamPanelPlaying', 'teamPanelRoundEnd', 'teamPanelGameEnd'].forEach(function (p) {
      var el = document.getElementById(p);
      if (el) el.hidden = p !== id;
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 3200);
  }

  // ---------- Almacenamiento local (por-visitante, solo conveniencia) ----------

  function loadLocal(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* almacenamiento no disponible: seguimos sin persistencia */
    }
  }
  function clearLocal(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  // ---------- Dibujo del ahorcado ----------

  function hangmanMarkup() {
    return (
      '<path class="stroke fixed" d="M20 210 H120" />' +
      '<path class="stroke fixed" d="M45 210 V20" />' +
      '<path class="stroke fixed" d="M45 20 H140" />' +
      '<path class="stroke fixed" d="M140 20 V45" />' +
      '<circle class="stroke part" data-stage="0" cx="140" cy="66" r="20" />' +
      '<path class="stroke part" data-stage="1" d="M140 86 V140" />' +
      '<path class="stroke part" data-stage="2" d="M140 100 L112 122" />' +
      '<path class="stroke part" data-stage="3" d="M140 100 L168 122" />' +
      '<path class="stroke part" data-stage="4" d="M140 140 L116 176" />' +
      '<path class="stroke part" data-stage="5" d="M140 140 L164 176" />' +
      '<path class="stroke part danger" data-stage="6" d="M132 60 L138 66 M138 60 L132 66" />' +
      '<path class="stroke part danger" data-stage="7" d="M142 60 L148 66 M148 60 L142 66" />'
    );
  }
  document.getElementById('hostHangmanSvg').innerHTML = hangmanMarkup();
  document.getElementById('teamHangmanSvg').innerHTML = hangmanMarkup();

  function updateHangman(svgEl, wrongCount) {
    if (!svgEl) return;
    var parts = svgEl.querySelectorAll('[data-stage]');
    for (var i = 0; i < parts.length; i++) {
      var stage = parseInt(parts[i].getAttribute('data-stage'), 10);
      parts[i].classList.toggle('visible', stage < wrongCount);
    }
  }

  function renderWordDisplay(container, wordDisplay) {
    container.innerHTML = '';
    (wordDisplay || []).forEach(function (item) {
      var slot = document.createElement('span');
      if (item.type === 'space') {
        slot.className = 'slot space';
        slot.textContent = '  ';
      } else if (item.type === 'dash') {
        slot.className = 'slot space';
        slot.textContent = '-';
      } else {
        slot.className = 'slot' + (item.value ? ' filled' : '');
        slot.textContent = item.value || '';
      }
      container.appendChild(slot);
    });
  }

  function renderTeamList(container, teams, highlightId) {
    container.innerHTML = '';
    (teams || []).forEach(function (t, idx) {
      var li = document.createElement('li');
      li.className = 'team-row' + (t.id === highlightId ? ' you' : '');
      var offline = t.connected === false ? ' · desconectado' : '';
      li.innerHTML =
        '<span class="rank">' + (idx + 1) + '</span>' +
        '<span class="name">' + escapeHtml(t.name) + offline + '</span>' +
        '<span class="score">' + t.score + '</span>';
      container.appendChild(li);
    });
    if (!teams || !teams.length) {
      var li2 = document.createElement('li');
      li2.className = 'team-row';
      li2.innerHTML = '<span class="name">Todavía no se une ningún equipo…</span>';
      container.appendChild(li2);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function podiumHtml(teams) {
    return (teams || [])
      .map(function (t, idx) {
        return '<li><span>' + (idx + 1) + '. ' + escapeHtml(t.name) + '</span><span>' + t.score + ' pts</span></li>';
      })
      .join('');
  }

  function breakdownHtml(history) {
    if (!history || !history.length) {
      return '<li>Todavía no hay rondas registradas.</li>';
    }
    return history
      .map(function (h) {
        var who = h.winnerName
          ? '<strong>' + escapeHtml(h.winnerName) + '</strong> ' + (REASON_LABELS[h.reason] || '')
          : 'Nadie acertó ninguna letra';
        var points = h.points > 0 ? '+' + h.points + ' pts' : '';
        return (
          '<li><div class="bd-top"><span class="bd-round">Ronda ' +
          h.round +
          '</span><span class="bd-points">' +
          points +
          '</span></div><div class="bd-word">' +
          escapeHtml(h.word) +
          '</div><div class="bd-reason">' +
          who +
          '</div></li>'
        );
      })
      .join('');
  }

  // ---------- Formulario inicial: una tarjeta por ronda ----------

  function resizeRoundDrafts(n) {
    n = Math.min(Math.max(parseInt(n, 10) || 1, 1), 20);
    while (roundDrafts.length < n) roundDrafts.push({ word: '', hint: '', maxAttempts: 6 });
    roundDrafts.length = n;
  }

  function renderRoundCards() {
    var container = document.getElementById('roundCardsContainer');
    container.innerHTML = '';
    roundDrafts.forEach(function (draft, idx) {
      var card = document.createElement('div');
      card.className = 'round-card';
      card.innerHTML =
        '<h3>Ronda ' + (idx + 1) + '</h3>' +
        '<label>Palabra o frase secreta</label>' +
        '<div class="masked-field">' +
        '<input type="password" autocomplete="off" spellcheck="false" placeholder="Ej. FOTOSÍNTESIS" data-role="word" value="' +
        escapeHtml(draft.word) +
        '">' +
        '<button type="button" data-role="toggle" aria-label="Mostrar u ocultar la palabra">👁️</button>' +
        '</div>' +
        '<label>Pista</label>' +
        '<input type="text" autocomplete="off" placeholder="Ej. Proceso de las plantas" data-role="hint" value="' +
        escapeHtml(draft.hint) +
        '">' +
        '<label>Dificultad</label>' +
        '<select data-role="difficulty">' +
        '<option value="8"' + (draft.maxAttempts === 8 ? ' selected' : '') + '>Fácil — 8 intentos</option>' +
        '<option value="6"' + (draft.maxAttempts === 6 ? ' selected' : '') + '>Normal — 6 intentos</option>' +
        '<option value="4"' + (draft.maxAttempts === 4 ? ' selected' : '') + '>Difícil — 4 intentos</option>' +
        '</select>';

      var wordInput = card.querySelector('[data-role="word"]');
      var hintInput = card.querySelector('[data-role="hint"]');
      var diffSelect = card.querySelector('[data-role="difficulty"]');
      var toggleBtn = card.querySelector('[data-role="toggle"]');

      wordInput.addEventListener('input', function () {
        roundDrafts[idx].word = wordInput.value;
      });
      hintInput.addEventListener('input', function () {
        roundDrafts[idx].hint = hintInput.value;
      });
      diffSelect.addEventListener('change', function () {
        roundDrafts[idx].maxAttempts = parseInt(diffSelect.value, 10);
      });
      toggleBtn.addEventListener('click', function () {
        var showing = wordInput.type === 'text';
        wordInput.type = showing ? 'password' : 'text';
        toggleBtn.textContent = showing ? '👁️' : '🙈';
      });

      container.appendChild(card);
    });
  }

  resizeRoundDrafts(parseInt(document.getElementById('totalRounds').value, 10) || 3);
  renderRoundCards();

  document.getElementById('totalRounds').addEventListener('input', function (e) {
    resizeRoundDrafts(e.target.value);
    renderRoundCards();
  });

  function prefillLobbyForm(plan) {
    var wordInput = document.getElementById('hostWordInput');
    var hintInput = document.getElementById('hostHintInput');
    var diffSelect = document.getElementById('hostDifficulty');
    wordInput.value = plan ? plan.word || '' : '';
    hintInput.value = plan ? plan.hint || '' : '';
    diffSelect.value = plan && plan.maxAttempts ? String(plan.maxAttempts) : '6';
    wordInput.type = 'password';
    document.getElementById('hostToggleMask').textContent = '👁️';
  }

  // ---------- Render principal según el estado del servidor ----------

  function render(state) {
    latestState = state;
    if (role === 'host') renderHost(state);
    if (role === 'team') renderTeam(state);
  }

  function renderHost(state) {
    document.getElementById('hostCodeBadge').textContent = state.code;
    document.getElementById('hostLobbyCode').textContent = state.code;
    var roundLabel = state.round > 0 ? state.round : '—';
    document.getElementById('hostRoundBadge').textContent = 'Ronda ' + roundLabel + ' de ' + state.totalRounds;
    document.getElementById('hostSubtitle').textContent =
      state.teams.length + (state.teams.length === 1 ? ' equipo conectado' : ' equipos conectados');

    if (state.status === 'lobby') {
      showHostPanel('hostPanelLobby');
      document.getElementById('hostLobbyTitle').textContent =
        state.round === 0 ? 'Prepara la primera ronda' : 'Prepara la ronda ' + (state.round + 1);
      renderTeamList(document.getElementById('hostLobbyTeamList'), state.teams, null);
    } else if (state.status === 'playing') {
      showHostPanel('hostPanelPlaying');
      document.getElementById('hostHintText').textContent = state.hint;
      renderWordDisplay(document.getElementById('hostWordDisplay'), state.wordDisplay);
      document.getElementById('hostWrongLetters').textContent = state.wrongLetters.length
        ? 'Letras falladas: ' + state.wrongLetters.join('  ')
        : '';
      document.getElementById('hostAttemptsLeft').textContent = Math.max(state.maxAttempts - state.wrongCount, 0);
      updateHangman(document.getElementById('hostHangmanSvg'), state.wrongCount);

      var banner = document.getElementById('hostStatusBanner');
      if (!state.buzzerOpen) {
        banner.textContent = '🔒 Cerraste el timbre — nadie puede tocarlo todavía';
        banner.className = 'status-banner closed';
      } else if (state.buzzer) {
        banner.textContent = '⏱ ' + state.buzzer.teamName + ' tiene el turno para responder';
        banner.className = 'status-banner active';
      } else {
        banner.textContent = 'Esperando a que un equipo toque el timbre…';
        banner.className = 'status-banner';
      }

      var gateBtn = document.getElementById('btnToggleBuzzerGate');
      gateBtn.textContent = state.buzzerOpen ? 'Cerrar timbre' : 'Abrir timbre';
      gateBtn.classList.toggle('active-gate', !state.buzzerOpen);

      renderTeamList(document.getElementById('hostPlayingTeamList'), state.teams, null);
    } else if (state.status === 'round_end') {
      showHostPanel('hostPanelRoundEnd');
      document.getElementById('hostRoundEndMessage').textContent = roundEndMessage(state, null);
      var isLast = state.round >= state.totalRounds;
      document.getElementById('btnNextRound').textContent = isLast ? 'Ver marcador final' : 'Siguiente ronda';
      renderTeamList(document.getElementById('hostRoundEndTeamList'), state.teams, null);
    } else if (state.status === 'game_end') {
      showHostPanel('hostPanelGameEnd');
      var winners = state.winners || [];
      document.getElementById('hostFinalMessage').textContent =
        winners.length > 1
          ? '¡Empate entre ' + winners.join(' y ') + '!'
          : winners.length === 1
          ? '🏆 ¡' + winners[0] + ' ganó el juego!'
          : '¡Juego terminado!';
      document.getElementById('hostFinalPodium').innerHTML = podiumHtml(state.teams);
      document.getElementById('hostBreakdownList').innerHTML = breakdownHtml(state.roundsHistory);
    }
  }

  function roundEndMessage(state, myTeamName) {
    var word = state.revealedWord;
    if (!state.roundWinnerName) {
      return 'Se acabaron los intentos y nadie acertó ninguna letra. La palabra era "' + word + '".';
    }
    var isMe = myTeamName && state.roundWinnerName === myTeamName;
    var who = isMe ? 'Tu equipo' : state.roundWinnerName;
    if (state.roundWinReason === 'most_correct') {
      return (
        '⏳ Se acabaron los intentos. ' +
        who +
        (isMe ? ' ganó' : ' ganó') +
        ' la ronda por tener más aciertos. La palabra era "' +
        word +
        '".'
      );
    }
    return '🎉 ¡' + who + (isMe ? ' acertó' : ' ganó') + ' la ronda! La palabra era "' + word + '".';
  }

  function renderTeam(state) {
    document.getElementById('teamCodeBadge').textContent = state.code;
    var roundLabel = state.round > 0 ? state.round : '—';
    document.getElementById('teamRoundBadge').textContent = 'Ronda ' + roundLabel + ' de ' + state.totalRounds;

    var myTeam = (state.teams || []).find(function (t) {
      return t.id === myTeamId;
    });
    document.getElementById('teamSubtitle').textContent = myTeam
      ? 'Puntaje del equipo: ' + myTeam.score
      : 'Conectado a la sala';

    if (state.status === 'lobby') {
      showTeamPanel('teamPanelLobby');
      renderTeamList(document.getElementById('teamLobbyTeamList'), state.teams, myTeamId);
    } else if (state.status === 'playing') {
      showTeamPanel('teamPanelPlaying');
      document.getElementById('teamHintText').textContent = state.hint;
      renderWordDisplay(document.getElementById('teamWordDisplay'), state.wordDisplay);
      document.getElementById('teamWrongLetters').textContent = state.wrongLetters.length
        ? 'Letras falladas: ' + state.wrongLetters.join('  ')
        : '';
      document.getElementById('teamAttemptsLeft').textContent = Math.max(state.maxAttempts - state.wrongCount, 0);
      updateHangman(document.getElementById('teamHangmanSvg'), state.wrongCount);

      var iHaveTurn = state.buzzer && state.buzzer.teamId === myTeamId;
      var gateClosed = state.buzzerOpen === false;
      var banner = document.getElementById('teamStatusBanner');
      var buzzBtn = document.getElementById('btnBuzz');
      var answerArea = document.getElementById('teamAnswerArea');
      var gateMsg = document.getElementById('buzzerGateMsg');

      if (iHaveTurn) {
        banner.textContent = '¡Es tu turno! Elige una letra o arriesga la palabra.';
        banner.className = 'status-banner mine';
      } else if (gateClosed) {
        banner.textContent = 'El anfitrión cerró el timbre por ahora.';
        banner.className = 'status-banner closed';
      } else if (state.buzzer) {
        banner.textContent = state.buzzer.teamName + ' tiene el turno…';
        banner.className = 'status-banner';
      } else {
        banner.textContent = '¡Toca el timbre si sabes la respuesta!';
        banner.className = 'status-banner';
      }

      buzzBtn.disabled = !!state.buzzer || gateClosed;
      buzzBtn.hidden = iHaveTurn;
      gateMsg.hidden = !gateClosed || iHaveTurn;
      answerArea.hidden = !iHaveTurn;

      if (iHaveTurn) buildTeamKeyboard(state);
      renderTeamList(document.getElementById('teamPlayingTeamList'), state.teams, myTeamId);
    } else if (state.status === 'round_end') {
      showTeamPanel('teamPanelRoundEnd');
      document.getElementById('teamRoundEndMessage').textContent = roundEndMessage(state, myTeam && myTeam.name);
      renderTeamList(document.getElementById('teamRoundEndTeamList'), state.teams, myTeamId);
    } else if (state.status === 'game_end') {
      showTeamPanel('teamPanelGameEnd');
      var winners2 = state.winners || [];
      var wonIt = myTeam && winners2.indexOf(myTeam.name) !== -1;
      document.getElementById('teamFinalMessage').textContent = wonIt
        ? '🏆 ¡Ganaron el juego!'
        : winners2.length
        ? 'Ganó ' + winners2.join(' y ') + '.'
        : '¡Juego terminado!';
      document.getElementById('teamFinalPodium').innerHTML = podiumHtml(state.teams);
      document.getElementById('teamBreakdownList').innerHTML = breakdownHtml(state.roundsHistory);
    }
  }

  function buildTeamKeyboard(state) {
    var kb = document.getElementById('teamKeyboard');
    var used = {};
    (state.wordDisplay || []).forEach(function (item) {
      if (item.type === 'letter' && item.value) used[item.value] = true;
    });
    var wrong = state.wrongLetters || [];

    kb.innerHTML = '';
    LETTERS.forEach(function (letter) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = letter;
      var isCorrect = Object.keys(used).some(function (u) {
        return u.normalize('NFD').replace(/[̀-ͯ]/g, '') === letter;
      });
      var isWrong = wrong.indexOf(letter) !== -1;
      if (isCorrect) {
        btn.className = 'correct';
        btn.disabled = true;
      } else if (isWrong) {
        btn.className = 'wrong';
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function () {
          socket.emit('team:guessLetter', { letter: letter }, function (res) {
            if (res && res.error) toast(res.error);
          });
        });
      }
      kb.appendChild(btn);
    });
  }

  // ---------- Navegación ----------

  document.getElementById('btnPickHost').addEventListener('click', function () {
    showScreen('screen-host-setup');
  });
  document.getElementById('btnPickTeam').addEventListener('click', function () {
    showScreen('screen-team-join');
  });
  document.querySelectorAll('[data-back="role"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      clearLocal('ahorcado_host');
      clearLocal('ahorcado_team');
      role = null;
      myTeamId = null;
      showScreen('screen-role');
    });
  });

  // ---------- Anfitrión ----------

  document.getElementById('btnCreateRoom').addEventListener('click', function () {
    var errEl = document.getElementById('hostSetupError');
    for (var i = 0; i < roundDrafts.length; i++) {
      var lettersOnly = (roundDrafts[i].word || '').replace(/[^A-Za-zÀ-ÿÑñ]/g, '');
      if (lettersOnly.length < 2) {
        errEl.textContent = 'La ronda ' + (i + 1) + ' necesita una palabra de al menos 2 letras.';
        return;
      }
      if (!(roundDrafts[i].hint || '').trim()) {
        errEl.textContent = 'La ronda ' + (i + 1) + ' necesita una pista.';
        return;
      }
    }
    errEl.textContent = '';

    socket.emit('host:createRoom', { rounds: roundDrafts }, function (res) {
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'No se pudo crear la sala.';
        return;
      }
      saveLocal('ahorcado_host', { roomCode: res.roomCode, hostToken: res.hostToken });
      role = 'host';
      prefillLobbyForm(res.nextRoundPlan);
      showScreen('screen-host-play');
    });
  });

  document.getElementById('hostToggleMask').addEventListener('click', function () {
    var input = document.getElementById('hostWordInput');
    var btn = document.getElementById('hostToggleMask');
    var showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁️' : '🙈';
  });

  document.getElementById('btnStartRound').addEventListener('click', function () {
    var word = document.getElementById('hostWordInput').value;
    var hint = document.getElementById('hostHintInput').value;
    var maxAttempts = document.getElementById('hostDifficulty').value;
    socket.emit('host:startRound', { word: word, hint: hint, maxAttempts: maxAttempts }, function (res) {
      var errEl = document.getElementById('hostRoundError');
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'No se pudo iniciar la ronda.';
        return;
      }
      errEl.textContent = '';
    });
  });

  document.getElementById('btnReleaseBuzzer').addEventListener('click', function () {
    socket.emit('host:releaseBuzzer', {});
  });
  document.getElementById('btnToggleBuzzerGate').addEventListener('click', function () {
    var open = !(latestState && latestState.buzzerOpen);
    socket.emit('host:setBuzzerOpen', { open: open });
  });
  document.getElementById('btnEndGameFromPlay').addEventListener('click', function () {
    if (confirm('¿Terminar el juego y mostrar el marcador final?')) socket.emit('host:endGame', {});
  });
  document.getElementById('btnEndGameFromRoundEnd').addEventListener('click', function () {
    socket.emit('host:endGame', {});
  });
  document.getElementById('btnNextRound').addEventListener('click', function () {
    socket.emit('host:nextRound', {}, function (res) {
      if (res && res.ok && !res.gameEnded) prefillLobbyForm(res.nextRoundPlan);
    });
  });

  // ---------- Equipos ----------

  document.getElementById('btnJoinRoom').addEventListener('click', function () {
    var code = document.getElementById('joinCode').value.trim().toUpperCase();
    var name = document.getElementById('joinTeamName').value.trim();
    var errEl = document.getElementById('teamJoinError');
    if (code.length !== 4) {
      errEl.textContent = 'El código tiene 4 caracteres.';
      return;
    }
    if (!name) {
      errEl.textContent = 'Escribe el nombre de tu equipo.';
      return;
    }

    socket.emit('team:join', { roomCode: code, teamName: name }, function (res) {
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'No se pudo unir a la sala.';
        return;
      }
      errEl.textContent = '';
      myTeamId = res.teamId;
      role = 'team';
      saveLocal('ahorcado_team', { roomCode: res.roomCode, teamName: res.teamName });
      document.getElementById('teamNameHeader').textContent = res.teamName;
      showScreen('screen-team-play');
    });
  });

  document.getElementById('btnBuzz').addEventListener('click', function () {
    socket.emit('team:buzz', {}, function (res) {
      if (res && res.error) toast(res.error);
    });
  });

  document.getElementById('btnGuessWord').addEventListener('click', function () {
    var input = document.getElementById('teamWordGuessInput');
    var word = input.value.trim();
    if (!word) return;
    socket.emit('team:guessWord', { word: word }, function (res) {
      if (res && res.error) toast(res.error);
      input.value = '';
    });
  });
  document.getElementById('teamWordGuessInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('btnGuessWord').click();
  });

  // ---------- Reconexión automática ----------

  socket.on('connect', function () {
    var hostSession = loadLocal('ahorcado_host');
    var teamSession = loadLocal('ahorcado_team');

    if (hostSession && hostSession.roomCode && hostSession.hostToken) {
      socket.emit('host:rejoinRoom', hostSession, function (res) {
        if (res && res.ok) {
          role = 'host';
          if (res.nextRoundPlan) prefillLobbyForm(res.nextRoundPlan);
          showScreen('screen-host-play');
        } else {
          clearLocal('ahorcado_host');
        }
      });
    } else if (teamSession && teamSession.roomCode && teamSession.teamName) {
      socket.emit(
        'team:join',
        { roomCode: teamSession.roomCode, teamName: teamSession.teamName },
        function (res) {
          if (res && res.ok) {
            role = 'team';
            myTeamId = res.teamId;
            document.getElementById('teamNameHeader').textContent = res.teamName;
            showScreen('screen-team-play');
          } else {
            clearLocal('ahorcado_team');
          }
        }
      );
    }
  });

  socket.on('state', function (state) {
    render(state);
  });

  socket.on('disconnect', function () {
    toast('Se perdió la conexión con el servidor. Intentando reconectar…');
  });
})();
