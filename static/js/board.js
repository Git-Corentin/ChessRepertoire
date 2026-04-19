/**
 * board.js — Wrapper de chessboard.js piloté par GameState.
 *
 * Responsabilités
 * ───────────────
 *  - Affiche le FEN courant de GameState (réagit aux changements de navIndex)
 *  - En mode training : permet le drag-and-drop, transmet à TRAINING.handleUserMove
 *  - Highlights : dernier coup joué, hint (vert), erreur (rouge)
 *  - Resize automatique
 */
"use strict";

const Board = (() => {

  let _board   = null;          // instance Chessboard
  let _chess   = null;          // instance chess.js — utilisée pour valider/normaliser les coups
  let _size    = 480;
  let _orientation = "white";
  let _onUserMove = null;       // callback (uci) => void, transmis par main.js
  let _lastHighlight = [];      // squares actuellement surlignées

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Initialise (ou ré-initialise) l'échiquier.
   * @param {string} orientation - "white" | "black"
   * @param {function} onUserMove - callback quand l'utilisateur drop une pièce
   */
  function init(orientation, onUserMove) {
    _orientation = orientation;
    _onUserMove  = onUserMove;
    _chess = new Chess();
    _computeSize();
    _create();
    window.addEventListener("resize", _onResize);
    GameState.subscribe(_onStateChange);
  }

  function _computeSize() {
    const wrap = document.getElementById("board-wrap");
    if (!wrap) return;
    const w = wrap.clientWidth - 48;
    const h = wrap.clientHeight - 48;
    _size = Math.max(280, Math.min(720, Math.min(w, h)));
    const c = document.getElementById("board-container");
    if (c) { c.style.width = `${_size}px`; c.style.height = `${_size}px`; }
  }

  function _onResize() {
    _computeSize();
    _board?.resize();
  }

  function _create() {
    if (_board) { _board.destroy(); _board = null; }

    const cfg = {
      position:    GameState.currentFen() || "start",
      orientation: _orientation,
      draggable:   true,                              // toujours draggable, on filtre dans onDragStart
      pieceTheme:  "/static/img/chesspieces/wikipedia/{piece}.png",
      onDragStart: _onDragStart,
      onDrop:      _onDrop,
      onSnapEnd:   _onSnapEnd,
      moveSpeed:   200,
      snapSpeed:   60,
    };
    _board = Chessboard("board-container", cfg);
    setTimeout(() => _board.resize(), 0);
  }

  // ── Drag & drop ───────────────────────────────────────────────────────────

  function _onDragStart(source, piece) {
    const st = GameState.get();

    // En visualisation : on autorise le drag de TOUTES les pièces (les deux couleurs)
    if (st.mode !== "training") {
      return true;
    }

    // En entraînement : ligne terminée ou nav désynchronisée → bloque
    if (st.lineDone) return false;
    if (GameState.isNavBehind()) {
      GameState.syncNavToPlay();
      return false;
    }

    // Filtrer la couleur (on ne joue que nos pièces en entraînement)
    const myColor = GameState.color();
    if (myColor === "white" && piece.startsWith("b")) return false;
    if (myColor === "black" && piece.startsWith("w")) return false;

    return true;
  }

  /**
   * Retourne la liste des représentations UCI possibles pour un coup.
   * Pour le roque, on renvoie les 2 variantes (roi→case cible et roi→tour)
   * pour être compatible avec les deux conventions.
   */
  function _possibleUciForms(move) {
    const base = move.from + move.to + (move.promotion || "");
    if (!move.flags) return [base];

    // Roque petit (k) ou grand (q) → ajouter les 2 conventions
    if (move.flags.includes("k")) {
      // Petit roque : e1g1 (standard) ou e1h1 (chess960)
      const rank = move.from[1];
      return [
        `e${rank}g${rank}`,
        `e${rank}h${rank}`,
      ];
    }
    if (move.flags.includes("q")) {
      // Grand roque : e1c1 (standard) ou e1a1 (chess960)
      const rank = move.from[1];
      return [
        `e${rank}c${rank}`,
        `e${rank}a${rank}`,
      ];
    }
    return [base];
  }

  function _onDrop(source, target) {
    const fen = GameState.currentFen();
    if (!fen) return "snapback";

    _chess.load(fen);
    const move = _chess.move({ from: source, to: target, promotion: "q" });
    if (!move) return "snapback";   // coup illégal aux échecs

    const uciForms = _possibleUciForms(move);
    const uci      = uciForms[0];  // UCI "canonique" pour l'affichage/envoi
    const st = GameState.get();

    // DEBUG: tracer les coups spéciaux (roque, prise en passant, promotion)
    if (move.flags && /[kqep]/.test(move.flags)) {
      console.log("[BOARD] coup spécial :", {
        from: move.from, to: move.to, flags: move.flags,
        san: move.san, piece: move.piece,
        uci_formes: uciForms,
        uci_attendu: st.line[st.playIndex]?.move_uci,
      });
    }

    // ── Mode visualisation : naviguer dans le répertoire ──────────────────
    if (st.mode !== "training") {
      const currentChildren = (st.navIndex < 0)
        ? (st.repertoire?.children || [])
        : (st.line[st.navIndex]?.children || []);

      // Chercher une correspondance avec l'une des formes UCI
      const matched = currentChildren.find(c => uciForms.includes(c.move_uci));
      if (!matched) {
        if (window.Sounds) Sounds.play("error");
        return "snapback";
      }

      const newPath = st.line.slice(0, st.navIndex + 1).concat([matched]);
      const isCapture = move.flags && move.flags.includes("c");
      if (window.Sounds) Sounds.play(isCapture ? "capture" : "move");
      _suppressNextSound = true;
      GameState.setExplorationPath(newPath);
      return;
    }

    // ── Mode entraînement ────────────────────────────────────────────────
    // Trouver la forme UCI qui correspond au coup attendu (pour éviter le rejet)
    const expectedUci = st.line[st.playIndex]?.move_uci;
    const uciToSend   = uciForms.includes(expectedUci) ? expectedUci : uci;

    const isCapture = move.flags && move.flags.includes("c");
    if (window.Sounds) Sounds.play(isCapture ? "capture" : "move");
    _suppressNextSound = true;

    if (_onUserMove) _onUserMove(uciToSend);
  }

  function _onSnapEnd() {
    // Re-synchroniser le board avec l'état après un coup
    const fen = GameState.currentFen();
    if (fen) _board?.position(fen, false);
  }

  // ── Réaction au GameState ────────────────────────────────────────────────

  let _lastDisplayedFen = null;
  let _suppressNextSound = false;  // mis à true par _onDrop pour éviter le double-son

  function _onStateChange(state, reason) {
    const fen = GameState.currentFen();

    // Re-créer le board si l'orientation a changé
    const newOrientation = state.repertoire?.color || "white";
    if (newOrientation !== _orientation) {
      _orientation = newOrientation;
      _create();
      _lastDisplayedFen = fen;
      return;
    }

    // Sinon, juste mettre à jour la position
    if (fen && _board) {
      _board.position(fen, true);

      // Son si la position a vraiment changé (et qu'on n'est pas dans un drop user)
      if (fen !== _lastDisplayedFen && _lastDisplayedFen !== null) {
        if (!_suppressNextSound && window.Sounds) {
          // Détecter capture en comparant le nombre de pièces
          const wasCapture = _countPieces(_lastDisplayedFen) > _countPieces(fen);
          Sounds.play(wasCapture ? "capture" : "move");
        }
        _suppressNextSound = false;
      }
      _lastDisplayedFen = fen;
    }

    // Highlights
    clearHighlights();
    if (state.navIndex >= 0 && state.line[state.navIndex]) {
      const uci = state.line[state.navIndex].move_uci;
      _highlight([uci.slice(0,2), uci.slice(2,4)], "highlight-last");
    }
  }

  function _countPieces(fen) {
    if (!fen) return 0;
    return (fen.split(" ")[0].match(/[a-zA-Z]/g) || []).length;
  }

  /** Appelé par training.js juste avant l'envoi pour éviter le double son. */
  function suppressNextSound() {
    _suppressNextSound = true;
  }

  // ── Highlights ────────────────────────────────────────────────────────────

  function clearHighlights() {
    _lastHighlight.forEach(({sq, cls}) => {
      document.querySelector(`#board-container [data-square="${sq}"]`)
        ?.classList.remove(cls);
    });
    _lastHighlight = [];
  }

  function _highlight(squares, cls) {
    squares.forEach(sq => {
      const el = document.querySelector(`#board-container [data-square="${sq}"]`);
      el?.classList.add(cls);
      _lastHighlight.push({ sq, cls });
    });
  }

  function highlightHint(uci) {
    if (!uci) return;
    clearHighlights();
    _highlight([uci.slice(0,2), uci.slice(2,4)], "highlight-hint");
  }

  function highlightError(uci) {
    if (!uci) return;
    clearHighlights();
    _highlight([uci.slice(0,2), uci.slice(2,4)], "highlight-error");
  }

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    init, clearHighlights, highlightHint, highlightError, suppressNextSound,
  };
})();

window.Board = Board;