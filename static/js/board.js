/**
 * board.js — Échiquier piloté par GameState.
 *
 * Philosophie de rendu (anti-flash) :
 * ─────────────────────────────────────
 * • moveSpeed:false → chessboard.js place les pièces instantanément, sans animation native
 * • Animations gérées en CSS custom (_animateMove) pour le coup adverse uniquement
 * • Après un drop user, _onSnapEnd est inhibé (_pendingDrop) car _onStateChange gère tout
 * • _onStateChange est la seule source de vérité pour l'affichage
 */
"use strict";

const Board = (() => {

  let _board       = null;
  let _chess       = null;
  let _size        = 480;
  let _orientation = "white";
  let _onUserMove  = null;
  let _lastHighlight = [];

  // Flags anti-flash
  let _pendingDrop      = false;  // drop en cours → inhiber _onSnapEnd
  let _wasSnapback      = false;  // dernier drop était un snapback
  let _suppressNextSound= false;  // son déjà joué par le drop → inhiber dans _onStateChange

  // FEN affiché la dernière fois (pour détecter les vrais changements)
  let _lastDisplayedFen = null;

  // ── Init ──────────────────────────────────────────────────────────────────

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

  function _onResize() { _computeSize(); _board?.resize(); }

  function _create() {
    if (_board) { _board.destroy(); _board = null; }
    _board = Chessboard("board-container", {
      position:    GameState.currentFen() || "start",
      orientation: _orientation,
      draggable:   true,
      pieceTheme:  "/static/img/chesspieces/wikipedia/{piece}.png",
      onDragStart: _onDragStart,
      onDrop:      _onDrop,
      onSnapEnd:   _onSnapEnd,
      moveSpeed:   false,
      snapSpeed:   60,
    });
    setTimeout(() => _board?.resize(), 0);
  }

  // ── Animation CSS custom ──────────────────────────────────────────────────

  /**
   * Anime une pièce de fromSq vers toSq sans bug de double-pièce.
   * Principe : place d'abord à destination, translate visuellement vers la source,
   * puis anime le retour (transition CSS). La pièce n'est jamais visible deux fois.
   */
  function _animateMove(fromSq, toSq, newFen, duration = 200) {
    const fromEl = document.querySelector(`#board-container [data-square="${fromSq}"]`);
    const toEl   = document.querySelector(`#board-container [data-square="${toSq}"]`);
    if (!fromEl || !toEl) { if (_board) _board.position(newFen, false); return; }

    const fromRect = fromEl.getBoundingClientRect();
    const toRect   = toEl.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top  - toRect.top;

    _board.position(newFen, false);

    const pieceImg = toEl.querySelector("img.piece-417db");
    if (!pieceImg) return;

    pieceImg.style.transition = "none";
    pieceImg.style.transform  = `translate(${dx}px, ${dy}px)`;
    void pieceImg.offsetWidth;                                    // force repaint
    pieceImg.style.transition = `transform ${duration}ms ease-in-out`;
    pieceImg.style.transform  = "translate(0, 0)";
    pieceImg.addEventListener("transitionend", () => {
      pieceImg.style.transition = "";
      pieceImg.style.transform  = "";
    }, { once: true });
  }

  // ── Drag & drop ───────────────────────────────────────────────────────────

  function _onDragStart(source, piece) {
    const st = GameState.get();

    if (st.mode === "correct") {
      if (st.correctionPhase !== "correcting") return false;
      const g = st.correctGame;
      if (!g || g.error_at === null) return false;
      const myColor = g.user_color;
      if (myColor === "white" && piece.startsWith("b")) return false;
      if (myColor === "black" && piece.startsWith("w")) return false;
      return true;
    }

    if (st.mode !== "training") return true;

    if (st.lineDone) return false;
    if (GameState.isNavBehind()) { GameState.syncNavToPlay(); return false; }
    const myColor = GameState.color();
    if (myColor === "white" && piece.startsWith("b")) return false;
    if (myColor === "black" && piece.startsWith("w")) return false;
    return true;
  }

  function _possibleUciForms(move) {
    const base = move.from + move.to + (move.promotion || "");
    if (!move.flags) return [base];
    if (move.flags.includes("k")) {
      const r = move.from[1];
      return [`e${r}g${r}`, `e${r}h${r}`];
    }
    if (move.flags.includes("q")) {
      const r = move.from[1];
      return [`e${r}c${r}`, `e${r}a${r}`];
    }
    return [base];
  }

  function _onDrop(source, target) {
    _wasSnapback = false;
    _pendingDrop = false;

    const fen = GameState.currentFen();
    if (!fen) { _wasSnapback = true; return "snapback"; }

    _chess.load(fen);
    const move = _chess.move({ from: source, to: target, promotion: "q" });
    if (!move) { _wasSnapback = true; return "snapback"; }

    const uciForms = _possibleUciForms(move);
    const uci = uciForms[0];
    const st  = GameState.get();

    // ── Mode correct ─────────────────────────────────────────────────────────
    if (st.mode === "correct") {
      if (st.correctionPhase !== "correcting") { _wasSnapback = true; return "snapback"; }
      if (!window.Correct?.handleUserMove)     { _wasSnapback = true; return "snapback"; }
      const accepted = Correct.handleUserMove(uci, uciForms, move);
      if (!accepted) { _wasSnapback = true; return "snapback"; }
      // Bon coup accepté par Correct (son joué là-bas)
      // _onSnapEnd ne sera PAS inhibé : il synchro au nouveau FEN (correct move-added)
      return;
    }

    // ── Mode visualisation ────────────────────────────────────────────────────
    if (st.mode !== "training") {
      const children = st.navIndex < 0
        ? (st.repertoire?.children || [])
        : (st.line[st.navIndex]?.children || []);
      const matched = children.find(c => uciForms.includes(c.move_uci));
      if (!matched) {
        if (window.Sounds) Sounds.play("error");
        _wasSnapback = true; return "snapback";
      }
      const newPath = st.line.slice(0, st.navIndex + 1).concat([matched]);
      if (window.Sounds) Sounds.play(move.flags?.includes("c") ? "capture" : "move");
      _suppressNextSound = true;
      _pendingDrop = true;  // inhiber _onSnapEnd, _onStateChange s'en charge
      GameState.setExplorationPath(newPath);
      return;
    }

    // ── Mode training ─────────────────────────────────────────────────────────
    const expectedUci = st.line[st.playIndex]?.move_uci;
    const uciToSend   = uciForms.includes(expectedUci) ? expectedUci : uci;
    if (window.Sounds) Sounds.play(move.flags?.includes("c") ? "capture" : "move");
    _suppressNextSound = true;
    _pendingDrop = true;  // inhiber _onSnapEnd jusqu'à la réponse du serveur
    if (_onUserMove) _onUserMove(uciToSend);
  }

  function _onSnapEnd() {
    // Si le drop est en cours de traitement async (training, viewing), ne rien faire.
    // _onStateChange sera appelé avec le bon FEN quand le serveur aura répondu.
    if (_pendingDrop) { _pendingDrop = false; return; }
    // Snapback : resync sans animation pour être sûr
    if (_wasSnapback) { _wasSnapback = false; }
    const fen = GameState.currentFen();
    if (fen && _board) _board.position(fen, false);
  }

  // ── Réaction au GameState ─────────────────────────────────────────────────

  function _onStateChange(state, reason) {
    const fen = GameState.currentFen();

    // Réorientation si couleur du répertoire change
    const newOrientation = state.repertoire?.color || "white";
    if (newOrientation !== _orientation) {
      _orientation = newOrientation;
      _create();
      _lastDisplayedFen = fen;
      return;
    }

    if (!fen || !_board) return;

    // ── Coup adverse en training (avec délai 500ms dans GameState) ────────────
    const isOpponentMove = (
      reason === "training-update"
      && !state.lineDone
      && !state.errors.includes(state.playIndex)
      && state.navIndex >= 0
      && state.line[state.navIndex]
      && _lastDisplayedFen !== null
      && !_samePosition(fen, _lastDisplayedFen)
    );

    if (isOpponentMove) {
      const uci    = state.line[state.navIndex].move_uci;
      const fromSq = uci.slice(0, 2);
      const toSq   = uci.slice(2, 4);
      _animateMove(fromSq, toSq, fen, 200);
      if (!_suppressNextSound && window.Sounds) {
        Sounds.play(_countPieces(_lastDisplayedFen) > _countPieces(fen) ? "capture" : "move");
      }
      _suppressNextSound = false;
      _lastDisplayedFen  = fen;
      setTimeout(() => {
        clearHighlights();
        if (_showLastMove) _highlight([fromSq, toSq], "highlight-last");
        _checkAndHighlightCheck(fen);
      }, 200);
      return;
    }

    // ── Erreur en training (mauvais coup joué) ────────────────────────────────
    // La pièce est visuellement à la mauvaise case (le drop l'a déposée).
    // On resync sans animation pour qu'elle revienne instantanément.
    const isTrainingError = (
      reason === "training-update"
      && state.errors.includes(state.playIndex)
    );
    if (isTrainingError) {
      _board.position(fen, false);
      _suppressNextSound = false;
      _lastDisplayedFen  = fen;
      clearHighlights();   // les highlights erreur sont gérés par training.js
      _checkAndHighlightCheck(fen);
      return;
    }

    // ── Tous les autres cas : position instantanée ────────────────────────────
    _board.position(fen, false);

    // Son (navigation, correction, etc.) — uniquement si la position a vraiment changé
    if (!_samePosition(fen, _lastDisplayedFen) && _lastDisplayedFen !== null) {
      if (!_suppressNextSound && window.Sounds) {
        Sounds.play(_countPieces(_lastDisplayedFen) > _countPieces(fen) ? "capture" : "move");
      }
    }
    _suppressNextSound = false;
    _lastDisplayedFen  = fen;

    // Highlights
    clearHighlights();
    if (_showLastMove && state.navIndex >= 0 && state.line[state.navIndex]) {
      const uci = state.line[state.navIndex].move_uci;
      _highlight([uci.slice(0,2), uci.slice(2,4)], "highlight-last");
    }
    _checkAndHighlightCheck(fen);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  let _showLastMove = false;  // toggle highlight-last (désactivé par défaut)

  function setShowLastMove(v) {
    _showLastMove = !!v;
    // Re-render immédiat
    const st = GameState.get();
    const fen = GameState.currentFen();
    if (!fen || !_board) return;
    clearHighlights();
    if (_showLastMove && st.navIndex >= 0 && st.line[st.navIndex]) {
      const uci = st.line[st.navIndex].move_uci;
      _highlight([uci.slice(0,2), uci.slice(2,4)], "highlight-last");
    }
    _checkAndHighlightCheck(fen);
  }

  function _countPieces(fen) {
    return fen ? (fen.split(" ")[0].match(/[a-zA-Z]/g) || []).length : 0;
  }

  function _samePosition(a, b) {
    if (!a || !b) return false;
    return a.split(" ").slice(0,4).join(" ") === b.split(" ").slice(0,4).join(" ");
  }

  function suppressNextSound() { _suppressNextSound = true; }

  function _checkAndHighlightCheck(fen) {
    if (!fen) return;
    try {
      const tmp = new Chess(fen);
      if (!tmp.in_check()) return;
      const color = tmp.turn();
      let kingSq = null;
      const board = tmp.board();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = board[r][c];
          if (p && p.type === "k" && p.color === color) {
            kingSq = String.fromCharCode(97 + c) + (8 - r);
          }
        }
      }
      if (!kingSq) return;
      const squareEl = document.querySelector(`#board-container [data-square="${kingSq}"]`);
      if (!squareEl) return;
      squareEl.classList.add("highlight-check");
      _lastHighlight.push({ sq: kingSq, cls: "highlight-check" });
      const pieceImg = squareEl.querySelector("img");
      if (pieceImg) {
        pieceImg.classList.remove("piece-shake");
        void pieceImg.offsetWidth;
        pieceImg.classList.add("piece-shake");
        pieceImg.addEventListener("animationend", () => pieceImg.classList.remove("piece-shake"), { once: true });
      }
      setTimeout(() => { if (window.Sounds) Sounds.play("check"); }, 80);
    } catch(e) {}
  }

  // ── Highlights ────────────────────────────────────────────────────────────

  function clearHighlights() {
    _lastHighlight.forEach(({ sq, cls }) => {
      document.querySelector(`#board-container [data-square="${sq}"]`)?.classList.remove(cls);
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

  function highlightSquare(sq, cls) {
    if (sq && cls) _highlight([sq], cls);
  }

  function setPosition(fen) {
    if (_board && fen) _board.position(fen, false);
  }

  // ── API publique ──────────────────────────────────────────────────────────
  return {
    init,
    clearHighlights, highlightHint, highlightError, highlightSquare, setPosition,
    suppressNextSound, setShowLastMove,
    animateMove: _animateMove,
  };
})();

window.Board = Board;