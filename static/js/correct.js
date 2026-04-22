/**
 * correct.js — Vue "Se corriger".
 *
 * Session 1 : formulaire pour charger les parties Chess.com du joueur,
 * affichage de la liste avec résumé (adversaire, date, résultat, erreur détectée).
 *
 * Sessions 2-3 : navigation dans une partie sélectionnée, bouton "Se corriger"
 * qui bascule vers l'entraînement sur la position fautive, persistance des erreurs.
 */
"use strict";

const Correct = (() => {

  let $username, $months, $onlyErrors, $fetchBtn, $status, $gamesList;
  let $fixBtn, $nextBtn, $backListBtn, $gameActions;
  let _slug = null;
  let _games = [];
  let _selectedGameId = null;
  let _selectedGame = null;
  // Pour éviter d'enregistrer plusieurs fois la même erreur dans la base
  const _errorSavedFor = new Set();
  // Nombre de fois que l'utilisateur a rejoué la même erreur (pour message)
  let _samePlayedCount = 0;

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    $username   = document.getElementById("correct-username");
    $months     = document.getElementById("correct-months");
    $onlyErrors = document.getElementById("correct-only-errors");
    $fetchBtn   = document.getElementById("correct-fetch-btn");
    $status     = document.getElementById("correct-status");
    $gamesList  = document.getElementById("correct-games-list");
    $gameActions = document.getElementById("correct-game-actions");
    $fixBtn     = document.getElementById("correct-fix-btn");
    $nextBtn    = document.getElementById("correct-next-btn");
    $backListBtn = document.getElementById("correct-back-list-btn");

    if (!$fetchBtn) return;

    $fetchBtn.addEventListener("click", _onFetch);
    $fixBtn?.addEventListener("click", _onFixNow);
    $nextBtn?.addEventListener("click", _onNextGame);
    $backListBtn?.addEventListener("click", _onBackToList);

    try {
      const stored = localStorage.getItem("correct-username");
      if (stored) $username.value = stored;
    } catch(e) {}

    GameState.subscribe(_onStateChange);
  }

  function _onStateChange(state, reason) {
    if (reason === "repertoire-change") {
      _slug = state.repertoire?.slug || null;
      // On ne vide pas la liste automatiquement : l'utilisateur peut vouloir
      // garder les parties affichées en changeant de répertoire pour comparer.
      // Mais on marque visuellement que les parties ne correspondent plus.
    }
  }

  function setContext(slug) {
    _slug = slug;
  }

  // ── Fetch ────────────────────────────────────────────────────────────────

  async function _onFetch() {
    const username = $username.value.trim();
    if (!username) {
      _showStatus("Entre un pseudo Chess.com", "error");
      return;
    }
    if (!_slug) {
      _showStatus("Aucun répertoire chargé", "error");
      return;
    }

    // Persister le pseudo pour la prochaine fois
    try { localStorage.setItem("correct-username", username); } catch(e) {}

    const months = parseInt($months.value, 10) || 3;
    const onlyErrors = !!$onlyErrors.checked;

    $fetchBtn.disabled = true;
    _showStatus(`Chargement des parties de ${username} (${months} mois)…`, "loading");
    $gamesList.innerHTML = "";

    try {
      const resp = await fetch("/api/correct/fetch/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": _csrf(),
        },
        body: JSON.stringify({
          username,
          repertoire_slug: _slug,
          months_back: months,
          only_with_error: onlyErrors,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `Erreur ${resp.status}`);
      }
      _games = data.games || [];
      _renderGames(data);
    } catch (e) {
      console.error(e);
      _showStatus(`Erreur : ${e.message}`, "error");
    } finally {
      $fetchBtn.disabled = false;
    }
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  function _renderGames(data) {
    const n = data.count || 0;
    if (n === 0) {
      _showStatus(
        `Aucune partie avec erreur trouvée sur ${data.months_back} mois.`,
        "info"
      );
      return;
    }
    _showStatus(
      `${n} partie${n > 1 ? "s" : ""} trouvée${n > 1 ? "s" : ""} pour ${data.username}.`,
      "info"
    );

    $gamesList.innerHTML = "";
    for (const g of _games) {
      $gamesList.appendChild(_buildGameCard(g));
    }
  }

  function _buildGameCard(g) {
    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.gameId = g.game_id;

    // Ligne 1 : adversaire + date
    const line1 = document.createElement("div");
    line1.className = "gc-line1";

    const opp = document.createElement("span");
    opp.className = "gc-opponent";
    const colorIcon = g.user_color === "white" ? "♔" : "♚";
    opp.textContent = `${colorIcon} vs ${g.opponent}`;
    line1.appendChild(opp);

    const date = document.createElement("span");
    date.className = "gc-date";
    date.textContent = _formatDate(g.played_at);
    line1.appendChild(date);

    card.appendChild(line1);

    // Ligne 2 : résultat + erreur/ok + cadence
    const line2 = document.createElement("div");
    line2.className = "gc-line2";

    const result = document.createElement("span");
    result.className = `gc-result-${g.user_result}`;
    result.textContent = _formatResult(g.user_result);
    line2.appendChild(result);

    const err = document.createElement("span");
    if (g.error_at !== null && g.error_at !== undefined) {
      err.className = "gc-error";
      const halfMove = g.error_at;
      const moveNum = Math.floor(halfMove / 2) + 1;
      const isWhite = halfMove % 2 === 0;
      const dots = isWhite ? "." : "...";
      err.textContent = `✗ erreur ${moveNum}${dots} ${g.played_san}`;
    } else {
      err.className = "gc-no-error";
      err.textContent = `✓ ligne suivie (${g.depth_reached})`;
    }
    line2.appendChild(err);

    const tc = document.createElement("span");
    tc.className = "gc-tc";
    tc.textContent = g.time_class;
    line2.appendChild(tc);

    card.appendChild(line2);

    card.addEventListener("click", () => _selectGame(g));

    return card;
  }

  function _selectGame(g) {
    _selectedGameId = g.game_id;
    _selectedGame = g;
    $gamesList.querySelectorAll(".game-card").forEach(c => {
      c.classList.toggle("selected", c.dataset.gameId === g.game_id);
    });

    // Charger la partie — loadCorrectionGame positionne directement à l'erreur
    GameState.loadCorrectionGame(g, null);

    // Afficher les boutons d'action
    $gameActions?.classList.add("visible");
    if ($fixBtn) {
      $fixBtn.textContent = "Corriger";
      $fixBtn.style.display = (g.error_at !== null && g.error_at !== undefined) ? "" : "none";
    }

    if ($gamesList) $gamesList.style.display = "none";

    if (g.error_at !== null && g.error_at !== undefined) {
      // Son d'erreur dès l'arrivée sur la position fautive
      if (window.Sounds) Sounds.play("error");
      // Highlight rouge sur le board
      if (window.Board) Board.highlightError(g.played_uci);

      const halfMove = g.error_at;
      const moveNum = Math.floor(halfMove / 2) + 1;
      const dots = halfMove % 2 === 0 ? "." : "...";
      _showStatus(
        `Coup ${moveNum}${dots} — tu as joué <strong>${g.played_san}</strong>, coup attendu : <strong>${_formatExpected(g.expected_moves)}</strong>. Clique sur Corriger pour rejouer.`,
        "error"
      );
    } else {
      _showStatus(`Partie suivie sans erreur (${g.depth_reached} coups).`, "info");
    }
  }

  function _formatExpected(expected) {
    if (!expected || !expected.length) return "?";
    if (expected.length === 1) return expected[0].san;
    const sorted = [...expected].sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    const top = sorted.slice(0, 3).map(m => m.san);
    return top.join(" / ") + (sorted.length > 3 ? "…" : "");
  }

  // ── Actions : Se corriger, partie suivante, retour liste ─────────────────

  /**
   * Appelé par Board._onDrop quand l'utilisateur joue un coup en phase correcting.
   * Gère la validation :
   *   - Coup correct (∈ expected_moves) → ajoute le coup au GameState, son success
   *   - Même erreur qu'avant → son error, snap back, message "même erreur"
   *   - Autre coup hors répertoire → son error, snap back, message générique
   *
   * @returns {boolean} true si le coup a été accepté, false sinon
   */
  function handleUserMove(playedUci, playedUciForms, move) {
    if (!_selectedGame) return false;
    const expected = _selectedGame.expected_moves || [];
    const originalErrorUci = _selectedGame.played_uci;

    const matched = expected.find(e =>
      playedUciForms.includes(e.uci) || playedUci === e.uci
    );

    if (matched) {
      // ✓ Bon coup
      if (window.Sounds) Sounds.play("correct");
      const state = GameState.get();
      const currentFen = state.line[state.navIndex]?.fen_after
         || state.repertoire?.correction_root_fen;
      const tmp = new Chess(currentFen);
      tmp.move({
        from: playedUci.slice(0,2),
        to:   playedUci.slice(2,4),
        promotion: playedUci.length > 4 ? playedUci[4] : undefined,
      });
      GameState.appendCorrectionMove({
        uci: matched.uci,
        san: matched.san,
        fen_after: tmp.fen(),
        is_our_move: true,
      });
      _showStatus(
        `✓ Bravo, <strong>${matched.san}</strong> est le bon coup !`,
        "success"
      );
      return true;
    }

    // Coup incorrect
    const isSameError = playedUciForms.includes(originalErrorUci)
                     || playedUci === originalErrorUci;

    if (window.Sounds) Sounds.play("error");
    if (isSameError) {
      _samePlayedCount++;
      _showStatus(
        `Tu fais la même erreur ! Coup attendu : <strong>${_formatExpected(expected)}</strong>`,
        "error"
      );
    } else {
      _showStatus(
        `Coup hors répertoire. Coup attendu : <strong>${_formatExpected(expected)}</strong>`,
        "error"
      );
    }
    return false;
  }

  /**
   * Bouton "Corriger" ↔ "Revoir l'erreur".
   *   - Si on est en phase browsing : passer en correcting (rejouer le coup).
   *     Enregistre l'erreur en base.
   *   - Si on est en phase correcting : revenir en browsing (revoir son erreur).
   */
  async function _onFixNow() {
    if (!_selectedGame || _selectedGame.error_at === null) return;

    const state = GameState.get();
    const phase = state.correctionPhase;

    if (phase === "browsing") {
      // Passer en correction : enregistrer l'erreur + basculer
      const errIdx = _selectedGame.error_at;
      const preFen = (errIdx === 0)
        ? (state.repertoire?.correction_root_fen || null)
        : state.line[errIdx - 1]?.fen_after;

      // Sauvegarde async non-bloquante
      if (!_errorSavedFor.has(_selectedGame.game_id)) {
        _errorSavedFor.add(_selectedGame.game_id);
        const expectedMove = _selectedGame.expected_moves?.[0];
        _saveError({
          fen: preFen,
          expected_uci: expectedMove?.uci,
          expected_san: expectedMove?.san,
          played_uci: _selectedGame.played_uci,
          played_san: _selectedGame.played_san,
          repertoire_slug: _slug,
          game_id: _selectedGame.game_id,
        }).catch(e => console.warn("[CORRECT] save-error échoué :", e));
      }

      // Basculer en mode correcting
      GameState.startCorrecting();
      _samePlayedCount = 0;
      if ($fixBtn) $fixBtn.textContent = "Revoir l'erreur";
      if (window.Board) Board.clearHighlights();
      _showStatus(
        `À toi de jouer — coup attendu : <strong>${_formatExpected(_selectedGame.expected_moves)}</strong>`,
        "info"
      );
    } else if (phase === "correcting") {
      // Revenir à la position d'erreur pour la revoir
      GameState.reviewError();
      if (window.Sounds) Sounds.play("error");
      if (window.Board) Board.highlightError(_selectedGame.played_uci);
      if ($fixBtn) $fixBtn.textContent = "Corriger";
      const halfMove = _selectedGame.error_at;
      const moveNum = Math.floor(halfMove / 2) + 1;
      const dots = halfMove % 2 === 0 ? "." : "...";
      _showStatus(
        `Coup ${moveNum}${dots} — tu avais joué <strong>${_selectedGame.played_san}</strong>, coup attendu : <strong>${_formatExpected(_selectedGame.expected_moves)}</strong>`,
        "error"
      );
    }
  }

  /**
   * "Partie suivante" : charge la partie suivante dans la liste (avec erreur).
   */
  function _onNextGame() {
    if (!_games.length) { _onBackToList(); return; }
    const curIdx = _games.findIndex(g => g.game_id === _selectedGameId);
    // On cherche la prochaine partie avec erreur (ou la première si pas trouvé)
    const nextErrIdx = _games.findIndex((g, i) =>
      i > curIdx && g.error_at !== null && g.error_at !== undefined
    );
    if (nextErrIdx >= 0) {
      _selectGame(_games[nextErrIdx]);
    } else {
      _showStatus("✓ Plus de partie avec erreur dans la liste !", "info");
      _onBackToList();
    }
  }

  /** Retour à la liste : on efface la sélection et réaffiche la liste. */
  function _onBackToList() {
    _selectedGameId = null;
    _selectedGame = null;
    GameState.clearCorrection();
    $gameActions?.classList.remove("visible");
    if ($gamesList) $gamesList.style.display = "";
    $gamesList.querySelectorAll(".game-card").forEach(c => c.classList.remove("selected"));
    _showStatus(`${_games.length} partie${_games.length > 1 ? "s" : ""} chargée${_games.length > 1 ? "s" : ""}.`, "info");
  }

  // ── Persistance des erreurs (Session 3) ──────────────────────────────────

  async function _saveError(payload) {
    const resp = await fetch("/api/correct/save-error/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf() },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _showStatus(msg, kind) {
    if (!$status) return;
    $status.textContent = msg;
    $status.className = `visible ${kind || ""}`.trim();
  }

  function _formatDate(iso) {
    if (!iso) return "";
    // Format attendu : "YYYY.MM.DDTHH:MM:SS" (venant de PGN) ou ISO standard
    const m = iso.match(/^(\d{4})[.\-](\d{2})[.\-](\d{2})/);
    if (!m) return iso;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function _formatResult(r) {
    return { win: "Victoire", loss: "Défaite", draw: "Nulle" }[r] || r;
  }

  function _csrf() {
    return document.cookie.split(";").map(c => c.trim())
      .find(c => c.startsWith("csrftoken="))?.split("=")?.[1] || "";
  }

  return { init, setContext, handleUserMove };
})();

window.Correct = Correct;