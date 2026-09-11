(function () {
  'use strict';

  var LETTERS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.split('');

  var socket = io();

  var role = null; // 'host' | 'team'
  var myTeamId = null;
  var latestState = null;

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
        slot.textContent = '  ';
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
      if (state.buzzer) {
        banner.textContent = '⏱ ' + state.buzzer.teamName + ' tiene el turno para responder';
        banner.className = 'status-banner active';
      } else {
        banner.textContent = 'Esperando a que un equipo toque el timbre…';
        banner.className = 'status-banner';
      }
      renderTeamList(document.getElementById('hostPlayingTeamList'), state.teams, null);
    } else if (state.status === 'round_end') {
      showHostPanel('hostPanelRoundEnd');
      var msg = state.roundWinnerName
        ? '🎉 ¡' + state.roundWinnerName + ' ganó la ronda! La palabra era "' + state.revealedWord + '".'
        : 'Se acabaron los intentos. La palabra era "' + state.revealedWord + '".';
      document.getElementById('hostRoundEndMessage').textContent = msg;
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
    }
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
      var banner = document.getElementById('teamStatusBanner');
      var buzzBtn = document.getElementById('btnBuzz');
      var answerArea = document.getElementById('teamAnswerArea');

      if (state.buzzer) {
        if (iHaveTurn) {
          banner.textContent = '¡Es tu turno! Elige una letra o arriesga la palabra.';
          banner.className = 'status-banner mine';
        } else {
          banner.textContent = state.buzzer.teamName + ' tiene el turno…';
          banner.className = 'status-banner';
        }
      } else {
        banner.textContent = '¡Toca el timbre si sabes la respuesta!';
        banner.className = 'status-banner';
      }

      buzzBtn.disabled = !!state.buzzer;
      buzzBtn.hidden = iHaveTurn;
      answerArea.hidden = !iHaveTurn;

      if (iHaveTurn) buildTeamKeyboard(state);
      renderTeamList(document.getElementById('teamPlayingTeamList'), state.teams, myTeamId);
    } else if (state.status === 'round_end') {
      showTeamPanel('teamPanelRoundEnd');
      var msg;
      if (state.roundWinnerName && state.roundWinnerName === (myTeam && myTeam.name)) {
        msg = '🎉 ¡Tu equipo acertó! La palabra era "' + state.revealedWord + '".';
      } else if (state.roundWinnerName) {
        msg = state.roundWinnerName + ' ganó esta ronda. La palabra era "' + state.revealedWord + '".';
      } else {
        msg = 'Se acabaron los intentos. La palabra era "' + state.revealedWord + '".';
      }
      document.getElementById('teamRoundEndMessage').textContent = msg;
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
        return u.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === letter;
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
    var rounds = parseInt(document.getElementById('totalRounds').value, 10) || 5;
    socket.emit('host:createRoom', { totalRounds: rounds }, function (res) {
      if (!res || !res.ok) {
        document.getElementById('hostSetupError').textContent = (res && res.error) || 'No se pudo crear la sala.';
        return;
      }
      saveLocal('ahorcado_host', { roomCode: res.roomCode, hostToken: res.hostToken });
      role = 'host';
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
      document.getElementById('hostWordInput').value = '';
      document.getElementById('hostHintInput').value = '';
      document.getElementById('hostWordInput').type = 'password';
      document.getElementById('hostToggleMask').textContent = '👁️';
    });
  });

  document.getElementById('btnReleaseBuzzer').addEventListener('click', function () {
    socket.emit('host:releaseBuzzer', {});
  });
  document.getElementById('btnEndGameFromPlay').addEventListener('click', function () {
    if (confirm('¿Terminar el juego y mostrar el marcador final?')) socket.emit('host:endGame', {});
  });
  document.getElementById('btnEndGameFromRoundEnd').addEventListener('click', function () {
    socket.emit('host:endGame', {});
  });
  document.getElementById('btnNextRound').addEventListener('click', function () {
    socket.emit('host:nextRound', {});
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
    var stored = loadLocal('ahorcado_team');
    var existingId = stored && stored.roomCode === code ? stored.teamId : undefined;

    socket.emit('team:join', { roomCode: code, teamName: name, teamId: existingId }, function (res) {
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'No se pudo unir a la sala.';
        return;
      }
      errEl.textContent = '';
      myTeamId = res.teamId;
      role = 'team';
      saveLocal('ahorcado_team', { roomCode: res.roomCode, teamId: res.teamId, teamName: res.teamName });
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
          showScreen('screen-host-play');
        } else {
          clearLocal('ahorcado_host');
        }
      });
    } else if (teamSession && teamSession.roomCode && teamSession.teamId) {
      socket.emit(
        'team:join',
        { roomCode: teamSession.roomCode, teamName: teamSession.teamName, teamId: teamSession.teamId },
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
