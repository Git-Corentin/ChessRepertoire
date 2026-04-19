/**
 * training.js — Interface d'entraînement.
 *
 * Pilotage
 * ────────
 *  - L'utilisateur clique "Nouvelle ligne" → POST /api/training/start/
 *    → applique la réponse à GameState
 *  - L'utilisateur drop une pièce (via Board) → handleUserMove(uci)
 *    → POST /api/training/move/ → applique la réponse
 *  - Si playIndex avance d'un cran avec un coup adverse intermédiaire,
 *    on l'anime visuellement avant d'ouvrir le tour à l'utilisateur.
 *  - Indice : POST /api/training/hint/ → la réponse révèle expectedMove
 *  - Verrou : POST /api/training/lock/ avec lock_fen + lock_node_path actuels
 *
 * Navigation clavier
 * ──────────────────
 *  ←/→ : déplace navIndex sur la ligne (purement visuel, ne joue pas)
 *  Quand l'utilisateur joue le bon coup et que isNavBehind() est vrai,
 *  on resync automatiquement (géré par syncNavToPlay dans applyTrainingResponse).
 */
"use strict";

const Training = (() => {

  let _slug = null;
  let _freq = 0.001;
  let _bias = 1.0;            // weight_exponent envoyé au backend
  let _opponentTimer = null;

  // DOM cache
  let $status, $statusText, $progressBar, $btnHint, $btnNext,
      $btnLock, $btnUnlock, $lockInd, $autoToggle;

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    $status      = document.getElementById("training-status");
    $statusText  = $status?.querySelector(".status-text");
    $progressBar = document.getElementById("training-progress-bar");
    $btnHint     = document.getElementById("btn-hint");
    $btnNext     = document.getElementById("btn-next-line");
    $btnLock     = document.getElementById("btn-lock");
    $btnUnlock   = document.getElementById("btn-unlock");
    $lockInd     = document.getElementById("lock-indicator");
    $autoToggle  = document.getElementById("auto-chain-toggle");

    $btnNext?.addEventListener("click", () => startNewLine());
    $btnHint?.addEventListener("click", () => requestHint());
    $btnLock?.addEventListener("click", () => lockPosition());
    $btnUnlock?.addEventListener("click", () => unlockPosition());
    $autoToggle?.addEventListener("change", e => GameState.setAutoChain(e.target.checked));

    GameState.subscribe(_onStateChange);
  }

  function _onStateChange(state, reason) {
    if (reason === "training-update") {
      _renderStatus(state);
      _renderProgress(state);
    }
    if (reason === "lock-change") _renderLock(state);
  }

  // ── Démarrage d'une ligne ─────────────────────────────────────────────────

  function setContext(slug, freq, bias) {
    _slug = slug;
    _freq = freq;
    if (bias !== undefined && bias !== null) _bias = bias;
  }

  async function startNewLine() {
    if (!_slug) return;
    clearTimeout(_opponentTimer);
    _setStatus("waiting", "Chargement…");
    Board.clearHighlights();

    const lock = GameState.get().lock;
    try {
      const data = await _post("/api/training/start/", {
        slug: _slug,
        freq: _freq,
        weight_exponent: _bias,
        lock_fen:        lock?.fen || null,
        lock_node_path:  lock?.path || [],
      });
      // Le backend renvoie aussi root_fen, color, initial_moves
      // On les met dans l'état repertoire si pas déjà
      const st = GameState.get();
      if (st.repertoire) {
        st.repertoire.root_fen      = data.root_fen      || st.repertoire.root_fen;
        st.repertoire.color         = data.color         || st.repertoire.color;
        st.repertoire.initial_moves = data.initial_moves || st.repertoire.initial_moves;
      }
      GameState.applyTrainingResponse(data);
      _afterUpdate(data);
    } catch(e) {
      console.error(e);
      _setStatus("error", "Erreur réseau");
    }
  }

  // ── Coup utilisateur ──────────────────────────────────────────────────────

  async function handleUserMove(uci) {
    const st = GameState.get();
    if (st.lineDone) return;

    // Si on est en nav arrière, resync silencieusement avant de continuer
    if (GameState.isNavBehind()) {
      GameState.syncNavToPlay();
    }

    try {
      const data = await _post("/api/training/move/", { move_uci: uci });
      GameState.applyTrainingResponse(data);
      _afterUpdate(data, uci);
    } catch(e) {
      console.error(e);
    }
  }

  /**
   * Logique post-réponse API :
   *  - Si erreur enregistrée à playIndex → highlight rouge, message
   *  - Si line_done → message + auto-chain éventuel
   *  - Sinon, si des coups adverses sont à jouer entre playIndex précédent et nouveau
   *    → animer ces coups
   */
  function _afterUpdate(data, playedUci) {
    const st = GameState.get();
    const idx = st.playIndex;

    // Erreur ?
    if (st.errors.includes(idx) && st.expectedMove) {
      if (window.Sounds) Sounds.play("error");
      _setStatus("error",
        `Erreur — coup attendu : <strong>${st.expectedMove.san}</strong><br>Jouez ce coup pour continuer`);
      Board.highlightError(st.expectedMove.uci);
      return;
    }

    // Ligne terminée
    if (st.lineDone) {
      if (window.Sounds) Sounds.play("correct");
      _setStatus("done", "✓ Ligne terminée !");
      Board.clearHighlights();
      if (st.autoChain) {
        setTimeout(() => startNewLine(), 1400);
      }
      return;
    }

    // Coups adverses à jouer entre l'ancien et le nouveau playIndex ?
    // Le board a déjà mis à jour la position au playIndex - 1 (dernier coup adverse joué)
    // → on est bon pour notre tour
    _setStatus("your-turn", "À vous de jouer");
  }

  // ── Indice ────────────────────────────────────────────────────────────────

  async function requestHint() {
    const st = GameState.get();
    if (st.lineDone) return;
    try {
      const data = await _post("/api/training/hint/", {});
      GameState.applyTrainingResponse(data);
      const newSt = GameState.get();
      if (newSt.expectedMove) {
        Board.highlightHint(newSt.expectedMove.uci);
        _setStatus("hint", `Indice : jouez <strong>${newSt.expectedMove.san}</strong>`);
      }
    } catch(e) { console.error(e); }
  }

  // ── Verrou ────────────────────────────────────────────────────────────────

  async function lockPosition() {
    const st = GameState.get();
    const fen = GameState.currentFen();
    if (!fen) return;

    // Refuser de verrouiller la position de départ (ça n'a pas de sens)
    if (st.navIndex < 0) {
      _setStatus("error", "Jouez au moins un coup avant de verrouiller");
      setTimeout(() => {
        if (!st.lineDone) _setStatus("your-turn", "À vous de jouer");
      }, 2500);
      return;
    }

    try {
      await _post("/api/training/lock/", {
        lock_fen: fen,
        lock_node_path: [],   // le backend retrouvera le path via le FEN
      });
      GameState.setLock(fen, []);
    } catch(e) { console.error(e); }
  }

  async function unlockPosition() {
    try {
      await _post("/api/training/lock/", { lock_fen: null, lock_node_path: [] });
      GameState.setLock(null);
    } catch(e) { console.error(e); }
  }

  // ── Rendu UI ──────────────────────────────────────────────────────────────

  function _renderStatus(state) {
    if (state.lineDone) return; // déjà géré dans _afterUpdate
    if (state.errors.includes(state.playIndex)) return;
  }

  function _renderProgress(state) {
    if (!$progressBar) return;
    const total = state.line.length;
    const done = state.playIndex;
    $progressBar.style.width = total ? `${Math.min(100, (done/total)*100)}%` : "0%";
  }

  function _renderLock(state) {
    if (!$lockInd) return;
    $lockInd.classList.toggle("active", !!state.lock);
  }

  function _setStatus(type, html) {
    if (!$status) return;
    $status.className = `s-${type}`;  // class précédée de s- pour éviter collisions
    if ($statusText) $statusText.innerHTML = html;
  }

  // ── Réseau ────────────────────────────────────────────────────────────────

  async function _post(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf() },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.status);
    return data;
  }

  function _csrf() {
    return document.cookie.split(";").map(c => c.trim())
      .find(c => c.startsWith("csrftoken="))?.split("=")?.[1] || "";
  }

  return {
    init, setContext,
    startNewLine, requestHint, lockPosition, unlockPosition,
    handleUserMove,
  };
})();

window.Training = Training;