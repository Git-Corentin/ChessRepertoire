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

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    subscribe, get, currentFen, color,
    setMode, setRepertoire,
    setExplorationPath, resetExploration,
    applyTrainingResponse,
    navForward, navBackward, navToIndex, syncNavToPlay, isNavBehind,
    setAutoChain, setLock,
  };
})();

window.GameState = GameState;