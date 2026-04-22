/**
 * gamestate.js — Source unique de vérité de l'état du jeu.
 *
 * Architecture
 * ────────────
 * Tous les autres modules (BOARD, TARGET, TREE, TRAINING) consomment et modifient
 * cet état via les méthodes publiques. Quand l'état change, GameState émet des
 * événements ("gamestate:change") que les vues écoutent pour se mettre à jour.
 *
 * État
 * ────
 * mode         : "viewing" | "training"
 * repertoire   : { slug, color, root_fen, initial_moves, children, ... } | null
 * line         : liste de nœuds (avec move_uci, fen_after, is_our_move) — la
 *                ligne en cours :
 *                  - en viewing : chemin construit depuis la racine
 *                                 (à mesure qu'on clique dans la cible/arbre)
 *                  - en training : la ligne tirée au sort par le backend
 * navIndex     : index du coup en cours d'AFFICHAGE (-1 = position racine)
 *                C'est ce qui détermine la position du board.
 * playIndex    : (training only) index du PROCHAIN coup à jouer.
 *                Pendant la nav clavier, navIndex peut différer de playIndex.
 * errors       : indices des coups erronés (training only)
 * revealed     : indices des coups révélés (training only)
 * autoChain    : bool — auto-enchaîner les lignes
 * lock         : { fen, path } | null — verrou de position en training
 */
"use strict";

const GameState = (() => {

  // ── État interne ──────────────────────────────────────────────────────────
  const _state = {
    mode:        "viewing",
    repertoire:  null,
    line:        [],          // liste de nœuds
    navIndex:    -1,          // -1 = avant le 1er coup de la ligne
    playIndex:   0,           // (training) prochain coup à jouer
    errors:      [],
    revealed:    [],
    autoChain:   false,
    lock:        null,
    expectedMove: null,       // {uci, san} si révélé
    lineDone:    false,
  };

  // ── Listeners ─────────────────────────────────────────────────────────────
  const _listeners = new Set();
  function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
  function _notify(reason) {
    for (const fn of _listeners) {
      try { fn(_state, reason); } catch(e) { console.error(e); }
    }
  }

  // ── Getters ───────────────────────────────────────────────────────────────
  function get() { return _state; }

  /** FEN à afficher actuellement sur le board. */
  function currentFen() {
    if (_state.navIndex < 0) {
      // Position initiale : racine de la partie en mode correct, ou racine du répertoire
      if (_state.mode === "correct") {
        return _state.repertoire?.correction_root_fen
          || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      }
      return _state.repertoire?.root_fen || null;
    }
    return _state.line[_state.navIndex]?.fen_after || null;
  }

  /** Couleur jouée par l'utilisateur. */
  function color() { return _state.repertoire?.color || "white"; }

  // ── Mode ──────────────────────────────────────────────────────────────────
  function setMode(mode) {
    if (_state.mode === mode) return;
    _state.mode = mode;
    // Reset nav et état de training quand on change de mode
    _state.navIndex = -1;
    _state.line = [];
    _state.playIndex = 0;
    _state.errors = [];
    _state.revealed = [];
    _state.expectedMove = null;
    _state.lineDone = false;
    _notify("mode-change");
  }

  // ── Répertoire ────────────────────────────────────────────────────────────
  function setRepertoire(rep) {
    _state.repertoire = rep;
    _state.line = [];
    _state.navIndex = -1;
    _state.playIndex = 0;
    _state.errors = [];
    _state.revealed = [];
    _state.expectedMove = null;
    _state.lineDone = false;
    _notify("repertoire-change");
  }

  // ── Visualisation : naviguer dans l'arbre ─────────────────────────────────

  /**
   * Met à jour la "ligne d'exploration" en mode viewing en y ajoutant un nœud.
   * Si on clique sur un nœud qui n'est pas la suite directe, on tronque puis ajoute.
   * @param {Array<dict>} path  chemin complet de nœuds depuis la racine du répertoire
   *                            jusqu'au nœud cliqué (inclus).
   */
  function setExplorationPath(path) {
    if (_state.mode !== "viewing") return;
    _state.line = path.slice();
    _state.navIndex = path.length - 1;  // affiche le dernier nœud
    _notify("nav-change");
  }

  /** Reset à la racine en visualisation. */
  function resetExploration() {
    if (_state.mode !== "viewing") return;
    _state.line = [];
    _state.navIndex = -1;
    _notify("nav-change");
  }

  // ── Training : appliquer une réponse API ─────────────────────────────────

  /**
   * Applique une réponse complète de l'API training (start/move/hint).
   * data: { line, current_index, errors, revealed, expected_move, line_done, ... }
   */
  function applyTrainingResponse(data) {
    if (_state.mode !== "training") return;

    _state.line         = data.line || [];
    _state.playIndex    = data.current_index ?? 0;
    _state.errors       = data.errors || [];
    _state.revealed     = data.revealed || [];
    _state.expectedMove = data.expected_move || null;
    _state.lineDone     = !!data.line_done;

    // Position d'affichage = playIndex - 1 (le board affiche le dernier coup joué)
    // ou la fin si line_done
    if (_state.lineDone) {
      _state.navIndex = _state.line.length - 1;
    } else {
      _state.navIndex = _state.playIndex - 1;
    }

    _notify("training-update");
  }

  // ── Navigation clavier ────────────────────────────────────────────────────

  function navForward() {
    const max = _state.line.length - 1;
    if (_state.navIndex >= max) return false;
    _state.navIndex++;
    _notify("nav-change");
    return true;
  }

  function navBackward() {
    if (_state.navIndex < 0) return false;
    _state.navIndex--;
    _notify("nav-change");
    return true;
  }

  function navToIndex(idx) {
    if (idx < -1 || idx >= _state.line.length) return false;
    _state.navIndex = idx;
    _notify("nav-change");
    return true;
  }

  /** Synchronise la navigation à la position de jeu réelle (training). */
  function syncNavToPlay() {
    if (_state.mode !== "training") return;
    if (_state.lineDone) {
      _state.navIndex = _state.line.length - 1;
    } else {
      _state.navIndex = _state.playIndex - 1;
    }
    _notify("nav-change");
  }

  /** Vrai si la nav clavier est désynchronisée de la position de jeu (training). */
  function isNavBehind() {
    if (_state.mode !== "training" || _state.lineDone) return false;
    return _state.navIndex !== _state.playIndex - 1;
  }

  // ── Toggles & verrou ──────────────────────────────────────────────────────
  function setAutoChain(v) { _state.autoChain = !!v; _notify("auto-chain"); }
  function setLock(fen, path) {
    _state.lock = fen ? { fen, path: path || [] } : null;
    _notify("lock-change");
  }

  // ── Mode correct : charger une partie ────────────────────────────────────

  /**
   * Charge une partie à corriger dans GameState. Calcule les FEN de chaque demi-coup.
   * game : { moves_uci, moves_san, user_color, error_at, played_san, expected_moves, game_id, opponent, result }
   * root_fen : position initiale de la partie (standard start position si non fourni)
   *
   * Après chargement, on se positionne DIRECTEMENT sur le coup fautif
   * (navIndex = error_at) et on entre en phase "browsing".
   */
  function loadCorrectionGame(game, root_fen) {
    _state.mode = "correct";
    _state.correctGame = game;
    _state.correctionPhase = "browsing";   // browsing | correcting
    _state.correctionLineExtra = [];       // coups joués par user en phase correcting

    const chess = new Chess(root_fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    const line = [];
    for (let i = 0; i < game.moves_uci.length; i++) {
      const uci = game.moves_uci[i];
      const from = uci.slice(0, 2);
      const to   = uci.slice(2, 4);
      const promo = uci.length > 4 ? uci[4] : undefined;
      const mv = chess.move({ from, to, promotion: promo });
      if (!mv) break;
      const is_user_move = (game.user_color === "white" && i % 2 === 0)
                        || (game.user_color === "black" && i % 2 === 1);
      line.push({
        move_uci: uci,
        move_san: game.moves_san[i] || mv.san,
        fen_after: chess.fen(),
        is_our_move: is_user_move,
        has_error: i === game.error_at,
      });
    }

    _state.line = line;
    _state.repertoire = _state.repertoire || {};
    _state.repertoire.correction_root_fen = root_fen
      || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    // Positionner directement sur le coup fautif (ou au début si pas d'erreur)
    if (game.error_at !== null && game.error_at !== undefined) {
      _state.navIndex = game.error_at;
    } else {
      _state.navIndex = -1;
    }
    _state.playIndex = 0;
    _state.errors = [];
    _state.revealed = [];
    _state.expectedMove = null;
    _state.lineDone = false;
    _notify("correction-loaded");
  }

  /** Passe de "browsing" à "correcting" : l'utilisateur va rejouer le coup. */
  function startCorrecting() {
    if (_state.mode !== "correct") return;
    const g = _state.correctGame;
    if (!g || g.error_at === null || g.error_at === undefined) return;
    _state.correctionPhase = "correcting";
    _state.correctionLineExtra = [];
    // Se placer à la position JUSTE AVANT l'erreur
    _state.navIndex = g.error_at - 1;
    _notify("correction-phase-change");
  }

  /** Retour en phase "browsing" : l'utilisateur revoit son erreur originale. */
  function reviewError() {
    if (_state.mode !== "correct") return;
    const g = _state.correctGame;
    if (!g || g.error_at === null || g.error_at === undefined) return;
    _state.correctionPhase = "browsing";
    _state.correctionLineExtra = [];
    // Tronquer la ligne à la longueur originale de la partie
    // (au cas où l'utilisateur aurait ajouté des coups en corrigeant)
    if (g.moves_uci && _state.line.length > g.moves_uci.length) {
      _state.line = _state.line.slice(0, g.moves_uci.length);
    }
    // Rétablir has_error sur le coup fautif d'origine (au cas où on l'aurait modifié)
    _state.line.forEach((n, i) => { n.has_error = (i === g.error_at); });
    _state.navIndex = g.error_at;
    _notify("correction-phase-change");
  }

  /**
   * Ajoute un coup joué par l'utilisateur en phase correcting.
   * move: { uci, san, fen_after, is_our_move }
   */
  function appendCorrectionMove(move) {
    if (_state.mode !== "correct" || _state.correctionPhase !== "correcting") return;
    const g = _state.correctGame;
    // Si on est encore en train d'ajouter depuis la position d'erreur,
    // on tronque la ligne à navIndex et on ajoute à la suite
    _state.line = _state.line.slice(0, _state.navIndex + 1);
    _state.line.push({
      move_uci: move.uci,
      move_san: move.san,
      fen_after: move.fen_after,
      is_our_move: move.is_our_move,
      has_error: false,
      was_appended: true,  // marque les coups ajoutés en phase correcting
    });
    _state.navIndex = _state.line.length - 1;
    _state.correctionLineExtra.push(move);
    _notify("correction-move-added");
  }

  function clearCorrection() {
    _state.correctGame = null;
    _state.correctionPhase = null;
    _state.correctionLineExtra = [];
    _state.line = [];
    _state.navIndex = -1;
    _notify("correction-cleared");
  }

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    subscribe, get, currentFen, color,
    setMode, setRepertoire,
    setExplorationPath, resetExploration,
    applyTrainingResponse,
    navForward, navBackward, navToIndex, syncNavToPlay, isNavBehind,
    setAutoChain, setLock,
    loadCorrectionGame, clearCorrection,
    startCorrecting, reviewError, appendCorrectionMove,
  };
})();

window.GameState = GameState;