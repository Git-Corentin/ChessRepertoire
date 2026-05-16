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
  let $gameActions, $backListBtn, $nextBtn;
  let $errorActions, $fixBtn, $seeSolutionBtn;
  let $solvedActions, $continueBtn, $autoNextToggle;
  let _slug = null;
  let _games = [];
  let _selectedGameId = null;
  let _selectedGame = null;
  const _errorSavedFor = new Set();
  let _samePlayedCount = 0;
  let _solvedFen = null;
  let _solutionViewed = false; // true si l'utilisateur a demandé "Voir la solution"
  let _phase = "browsing";

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    $username    = document.getElementById("correct-username");
    $months      = document.getElementById("correct-months");
    $onlyErrors  = document.getElementById("correct-only-errors");
    $fetchBtn    = document.getElementById("correct-fetch-btn");
    $status      = document.getElementById("correct-status");
    $gamesList   = document.getElementById("correct-games-list");
    $gameActions = document.getElementById("correct-game-actions");
    $backListBtn = document.getElementById("correct-back-list-btn");
    $nextBtn     = document.getElementById("correct-next-btn");
    // Zone 1 : actions sur l'erreur
    $errorActions    = document.getElementById("correct-error-actions");
    $fixBtn          = document.getElementById("correct-fix-btn");
    $seeSolutionBtn  = document.getElementById("correct-see-solution-btn");
    // Zone 2 : après solution
    $solvedActions   = document.getElementById("correct-solved-actions");
    $continueBtn     = document.getElementById("correct-continue-btn");
    $autoNextToggle  = document.getElementById("correct-auto-next-toggle");

    if (!$fetchBtn) return;

    $fetchBtn.addEventListener("click", _onFetch);
    $fixBtn?.addEventListener("click", _onFixNow);
    $seeSolutionBtn?.addEventListener("click", _onSeeSolution);
    $nextBtn?.addEventListener("click", _onNextGame);
    $backListBtn?.addEventListener("click", _onBackToList);
    $continueBtn?.addEventListener("click", _onContinueInTraining);
    $autoNextToggle?.addEventListener("change", e => {
      // Si on active sur une phase solved déjà atteinte → passer à la suivante
      if (e.target.checked && _phase === "solved" && !_solutionViewed) {
        setTimeout(() => _onNextGame(), 600);
      }
    });

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

  // ── Gestion des phases ────────────────────────────────────────────────────

  /**
   * Point central de rendu des boutons selon la phase.
   * Phase "browsing"  : [Corriger] [Voir la solution]
   * Phase "correcting": [Revoir l'erreur] [Voir la solution]
   * Phase "solved"    : [Poursuivre?] + toggle auto-suivante + [Erreur suivante]
   */
  function _setPhase(phase) {
    _phase = phase;
    const hasError = _selectedGame?.error_at !== null && _selectedGame?.error_at !== undefined;

    // Zone 1 : actions erreur
    if ($errorActions) {
      $errorActions.style.display = (phase === "browsing" || phase === "correcting") ? "" : "none";
    }
    // Label du bouton Corriger / Revoir l'erreur
    if ($fixBtn) {
      $fixBtn.textContent = phase === "correcting" ? "Revoir l'erreur" : "Corriger";
      $fixBtn.style.display = hasError ? "" : "none";
    }
    // Voir la solution : toujours visible en browsing et correcting
    if ($seeSolutionBtn) {
      $seeSolutionBtn.style.display = (phase === "browsing" || phase === "correcting") ? "" : "none";
    }

    // Zone 2 : après solution
    if ($solvedActions) {
      $solvedActions.style.display = phase === "solved" ? "" : "none";
    }
    // Poursuivre : calculé séparément via _showContinueIfAvailable
    // Toggle auto-suivante : visible en solved, jamais masqué indépendamment de la phase
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
    _samePlayedCount = 0;
    _solvedFen = null;
    _solutionViewed = false;
    $gamesList.querySelectorAll(".game-card").forEach(c => {
      c.classList.toggle("selected", c.dataset.gameId === g.game_id);
    });

    GameState.loadCorrectionGame(g, null);

    $gameActions?.classList.add("visible");
    if ($gamesList) $gamesList.style.display = "none";
    if ($continueBtn) { $continueBtn.style.display = "none"; $continueBtn.disabled = false; }

    if (g.error_at !== null && g.error_at !== undefined) {
      if (window.Sounds) Sounds.play("error");
      if (window.Board) Board.highlightError(g.played_uci);
      const halfMove = g.error_at;
      const moveNum = Math.floor(halfMove / 2) + 1;
      const dots = halfMove % 2 === 0 ? "." : "...";
      _showStatus(
        `Au coup ${moveNum}${dots} tu as joué <strong>${g.played_san}</strong>.`,
        "error"
      );
      _setPhase("browsing");
    } else {
      _showStatus(`Partie suivie sans erreur (${g.depth_reached} coups).`, "info");
      _setPhase("solved");  // aucune erreur → on va direct à solved (bouton erreur suivante)
    }
  }

  function _formatExpected(expected) {
    if (!expected || !expected.length) return "?";
    if (expected.length === 1) return expected[0].san;
    const sorted = [...expected].sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    return sorted.slice(0, 3).map(m => m.san).join(" / ") + (sorted.length > 3 ? "…" : "");
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function handleUserMove(playedUci, playedUciForms, move) {
    if (!_selectedGame) return false;
    const expected = _selectedGame.expected_moves || [];
    const originalErrorUci = _selectedGame.played_uci;

    const matched = expected.find(e => playedUciForms.includes(e.uci) || playedUci === e.uci);

    if (matched) {
      if (window.Sounds) Sounds.play("correct");
      const state = GameState.get();
      const currentFen = state.line[state.navIndex]?.fen_after
        || state.repertoire?.correction_root_fen;
      const tmp = new Chess(currentFen);
      tmp.move({ from: playedUci.slice(0,2), to: playedUci.slice(2,4),
                 promotion: playedUci.length > 4 ? playedUci[4] : undefined });
      GameState.appendCorrectionMove({
        uci: matched.uci, san: matched.san,
        fen_after: tmp.fen(), is_our_move: true,
      });
      _solvedFen = tmp.fen();
      _showStatus(`✓ Bravo, <strong>${matched.san}</strong> est le bon coup !`, "success");
      _setPhase("solved");
      _showContinueIfAvailable(_solvedFen);
      // Auto-next uniquement si l'utilisateur a trouvé lui-même (pas demandé la solution)
      if ($autoNextToggle?.checked && !_solutionViewed) {
        setTimeout(() => _onNextGame(), 1200);
      }
      return true;
    }

    const isSameError = playedUciForms.includes(originalErrorUci) || playedUci === originalErrorUci;
    if (window.Sounds) Sounds.play("error");
    _showStatus(
      isSameError
        ? `Tu fais la même erreur ! Essaie encore.`
        : `Coup hors répertoire. Essaie encore.`,
      "error"
    );
    return false;
  }

  async function _onFixNow() {
    if (!_selectedGame || _selectedGame.error_at === null) return;
    if (_phase === "browsing") {
      // Sauvegarder l'erreur
      const state = GameState.get();
      const errIdx = _selectedGame.error_at;
      const preFen = errIdx === 0
        ? state.repertoire?.correction_root_fen
        : state.line[errIdx - 1]?.fen_after;
      if (!_errorSavedFor.has(_selectedGame.game_id)) {
        _errorSavedFor.add(_selectedGame.game_id);
        const exp = _selectedGame.expected_moves?.[0];
        _saveError({
          fen: preFen, expected_uci: exp?.uci, expected_san: exp?.san,
          played_uci: _selectedGame.played_uci, played_san: _selectedGame.played_san,
          repertoire_slug: _slug, game_id: _selectedGame.game_id,
        }).catch(e => console.warn("[CORRECT] save-error:", e));
      }
      GameState.startCorrecting();
      if (window.Board) Board.clearHighlights();
      _showStatus("À toi de jouer. Rejoue le bon coup.", "info");
      _setPhase("correcting");

    } else if (_phase === "correcting") {
      // Revoir l'erreur
      GameState.reviewError();
      if (window.Sounds) Sounds.play("error");
      if (window.Board) Board.highlightError(_selectedGame.played_uci);
      const halfMove = _selectedGame.error_at;
      const moveNum = Math.floor(halfMove / 2) + 1;
      const dots = halfMove % 2 === 0 ? "." : "...";
      _showStatus(`Au coup ${moveNum}${dots} tu avais joué <strong>${_selectedGame.played_san}</strong>.`, "error");
      _setPhase("browsing");
    }
  }

  function _onNextGame() {
    if (!_games.length) { _onBackToList(); return; }
    const errGames = _games.filter(g => g.error_at !== null && g.error_at !== undefined);
    if (errGames.length === 0) {
      _showStatus("Aucune partie avec erreur dans la liste.", "info");
      _onBackToList(); return;
    }
    const curIdx = errGames.findIndex(g => g.game_id === _selectedGameId);
    const nextIdx = (curIdx + 1) % errGames.length;
    if (nextIdx === 0 && curIdx !== -1) {
      // On a fait le tour
      _showStatus("✓ Toutes les erreurs revues ! Recommence ou charge de nouvelles parties.", "info");
      _onBackToList(); return;
    }
    _selectGame(errGames[nextIdx]);
  }

  function _onSeeSolution() {
    if (!_selectedGame) return;
    const exp = _selectedGame.expected_moves?.[0];
    if (!exp) return;

    _solutionViewed = true;

    const state = GameState.get();
    const errIdx = _selectedGame.error_at;

    // FEN avant l'erreur
    const preFen = errIdx === 0
      ? (state.repertoire?.correction_root_fen
         || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
      : state.line[errIdx - 1]?.fen_after;

    // FEN après le bon coup
    let solvedFen = null;
    try {
      const tmp = new Chess(preFen);
      const mv = tmp.move({ from: exp.uci.slice(0,2), to: exp.uci.slice(2,4),
                            promotion: exp.uci.length > 4 ? exp.uci[4] : undefined });
      if (mv) solvedFen = tmp.fen();
    } catch(e) {}
    _solvedFen = solvedFen;

    const errUci = _selectedGame.played_uci;
    const isOnError = state.navIndex === errIdx; // le mauvais coup est visible

    // Fonction qui anime le bon coup depuis preFen
    const playGoodMove = () => {
      if (window.Board) Board.setPosition(preFen);
      if (window.Board) Board.clearHighlights();
      // Highlights rouge sur cases de l'erreur
      if (errUci && window.Board) {
        Board.highlightSquare(errUci.slice(0,2), "highlight-error");
        Board.highlightSquare(errUci.slice(2,4), "highlight-error");
      }
      // Animer le bon coup
      if (solvedFen && window.Board) {
        Board.animateMove(exp.uci.slice(0,2), exp.uci.slice(2,4), solvedFen, 200);
        if (window.Sounds) Sounds.play("move");
      }
      // Vert par-dessus rouge après l'animation
      setTimeout(() => {
        if (window.Board) {
          Board.highlightSquare(exp.uci.slice(0,2), "highlight-hint");
          Board.highlightSquare(exp.uci.slice(2,4), "highlight-hint");
        }
      }, 205);
    };

    if (isOnError && errUci && preFen && window.Board) {
      // Animer le retrait du mauvais coup (destination → source)
      Board.animateMove(errUci.slice(2,4), errUci.slice(0,2), preFen, 180);
      if (window.Sounds) Sounds.play("move");
      setTimeout(playGoodMove, 280);
    } else {
      // Déjà avant l'erreur (phase correcting ou autre) → jouer directement
      setTimeout(playGoodMove, 30);
    }

    _showStatus(
      `Erreur : <strong>${_selectedGame.played_san}</strong> → Solution : <strong>${_formatExpected(_selectedGame.expected_moves)}</strong>`,
      "info"
    );
    _setPhase("solved");
    _showContinueIfAvailable(solvedFen);
    // Pas d'auto-next ici
  }

  /** Affiche le bouton Poursuivre si la position a des enfants dans le répertoire. */
  function _showContinueIfAvailable(fen) {
    if (!$continueBtn) return;
    const hasNext = _positionHasRepertoireChildren(fen);
    if (!hasNext) { $continueBtn.style.display = "none"; return; }
    // Si auto-next actif : Poursuivre visible seulement si on a demandé la solution
    const autoNext = !!$autoNextToggle?.checked;
    $continueBtn.style.display = (!autoNext || _solutionViewed) ? "" : "none";
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
    $status.innerHTML = msg;    // innerHTML pour les balises <strong>, etc.
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

  function _positionHasRepertoireChildren(fen) {
    if (!fen) return false;
    const normFen = fen.split(" ").slice(0, 4).join(" ");
    const st = GameState.get();
    const children = st.repertoire?.children || [];
    function walk(nodes) {
      for (const n of nodes) {
        const nFen = (n.fen_after || "").split(" ").slice(0, 4).join(" ");
        if (nFen === normFen) return (n.children || []).length > 0;
        if (walk(n.children || [])) return true;
      }
      return false;
    }
    return walk(children);
  }

  function _onContinueInTraining() {
    // Utiliser _solvedFen pour être sûr d'avoir la position après le bon coup
    const fen = _solvedFen || GameState.currentFen();
    if (!fen || !_slug) return;
    fetch("/api/training/lock/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf() },
      body: JSON.stringify({ lock_fen: fen, lock_node_path: [] }),
    }).then(() => GameState.setLock(fen, [])).catch(e => console.error(e));
    window.dispatchEvent(new CustomEvent("switch-view", { detail: { mode: "training" } }));
  }

  function _csrf() {
    return document.cookie.split(";").map(c => c.trim())
      .find(c => c.startsWith("csrftoken="))?.split("=")?.[1] || "";
  }

  return { init, setContext, handleUserMove };
})();

window.Correct = Correct;