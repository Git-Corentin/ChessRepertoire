/**
 * main.js — Orchestrateur principal.
 *
 * Responsabilités
 * ───────────────
 *  - Chargement de la liste des répertoires
 *  - Slider fréquence
 *  - Switch de vue (Visualiser / S'entraîner)
 *  - Navigation clavier ←/→ (toujours active, indépendante du mode)
 *  - Initialise tous les autres modules
 */
"use strict";

(async () => {

  let _slug = null;
  let _freq = 0.001;
  let _bias = 1.0;

  const $ = id => document.getElementById(id);

  // ── Init des modules ─────────────────────────────────────────────────────
  Tree.init($("tree-container"));
  Target.init($("target-svg"), $("target-breadcrumb"));
  Training.init();
  if (window.Correct) Correct.init();

  Board.init(GameState.color(), uci => Training.handleUserMove(uci));

  // ── Notation sous le board ───────────────────────────────────────────────
  GameState.subscribe((state, reason) => {
    if (["nav-change", "training-update", "repertoire-change", "mode-change",
         "correction-loaded", "correction-cleared"]
        .includes(reason)) {
      _renderNotation(state);
    }
  });

  function _renderNotation(state) {
    const el = $("notation-bar");
    if (!el) return;
    el.innerHTML = "";
    if (!state.line.length) return;

    // Détecter si la position de départ est blanche ou noire pour numérotation
    // Simplification : on suppose que la racine est en début de partie
    // (initial_moves donnent l'indice — ici on prend juste demi-coup sequentiel)
    let halfMove = 0;

    for (let i = 0; i < state.line.length; i++) {
      const m = state.line[i];

      // Numéro de coup avant chaque coup blanc
      if (halfMove % 2 === 0) {
        const num = document.createElement("span");
        num.className = "notation-num";
        num.textContent = `${Math.floor(halfMove/2) + 1}.`;
        el.appendChild(num);
      }

      const span = document.createElement("span");
      const isCurrent = i === state.navIndex;

      // Coups futurs à masquer selon le mode :
      // - training : masquer tout ce qui est >= playIndex (sauf si révélé)
      // - correct+browsing : masquer tout ce qui est après error_at
      // - correct+correcting : masquer tout ce qui n'est pas dans la ligne visible
      //                        (la ligne est déjà tronquée + ajoutée par appendCorrectionMove)
      let shouldHide = false;
      if (state.mode === "training") {
        const isFuture = i >= state.playIndex && !state.lineDone;
        const isRevealedNow = i === state.playIndex && state.expectedMove;
        shouldHide = isFuture && !isRevealedNow;
      } else if (state.mode === "correct") {
        const g = state.correctGame;
        if (g && g.error_at !== null && g.error_at !== undefined) {
          if (state.correctionPhase === "browsing") {
            // Masquer tout ce qui vient APRÈS l'erreur
            shouldHide = i > g.error_at;
          }
          // En correcting : la line est tronquée + reconstruite par GameState,
          // donc tout ce qui est dans state.line est visible. Pas de masquage.
        }
      }

      span.className = [
        "notation-move",
        m.is_our_move ? "ours" : "theirs",
        isCurrent ? "nav-current" : "",
        m.has_error    ? "n-error" : "",
        m.was_revealed ? "n-hint"  : "",
        m.was_appended ? "n-appended" : "",
        shouldHide     ? "n-hidden" : "",
      ].filter(Boolean).join(" ");
      span.textContent = shouldHide ? "···" : m.move_san;

      const idx = i;
      if (!shouldHide) {
        span.addEventListener("click", () => GameState.navToIndex(idx));
      }

      el.appendChild(span);
      el.appendChild(document.createTextNode(" "));
      halfMove++;
    }

    // Scroll vers le coup courant
    el.querySelector(".nav-current")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ── Chargement des répertoires ───────────────────────────────────────────

  async function loadRepertoires() {
    try {
      const data = await fetch("/api/repertoires/").then(r => r.json());
      const sel = $("repertoire-select");
      sel.innerHTML = "";

      if (!data.repertoires || !data.repertoires.length) {
        sel.innerHTML = "<option>Aucun répertoire trouvé</option>";
        return;
      }

      for (const r of data.repertoires) {
        const opt = document.createElement("option");
        opt.value = r.slug;
        opt.textContent = `${r.opening_name} · ${r.elo_range} · ${r.color === "white" ? "Blancs" : "Noirs"}`;
        sel.appendChild(opt);
      }
      await loadTree(data.repertoires[0].slug, _freq);
    } catch(e) { console.error(e); }
  }

  async function loadTree(slug, freq) {
    _slug = slug;
    _freq = freq;
    Training.setContext(slug, freq, _bias);
    if (window.Correct) Correct.setContext(slug);

    try {
      const data = await fetch(`/api/tree/${slug}/?freq=${freq}`).then(r => r.json());
      $("sidebar-title").textContent =
        `${data.opening_name} · ${data.line_count} ligne${data.line_count > 1 ? "s" : ""}`;
      GameState.setRepertoire({
        slug, ...data,
      });
    } catch(e) { console.error(e); }
  }

  $("repertoire-select")?.addEventListener("change", e => loadTree(e.target.value, _freq));

  // ── Slider fréquence ─────────────────────────────────────────────────────

  function sliderToFreq(v) {
    const lo = Math.log10(0.00001), hi = Math.log10(0.1);
    return Math.pow(10, lo + (v / 100) * (hi - lo));
  }
  function freqToSlider(f) {
    const lo = Math.log10(0.00001), hi = Math.log10(0.1);
    return ((Math.log10(f) - lo) / (hi - lo)) * 100;
  }
  function fmtFreq(f) {
    if (f >= 0.01)  return `${(f*100).toFixed(1)}%`;
    if (f >= 0.001) return `${(f*100).toFixed(2)}%`;
    return `${(f*100).toFixed(3)}%`;
  }

  const $slider = $("freq-slider"), $fval = $("freq-value");
  if ($slider) {
    $slider.value = freqToSlider(_freq).toFixed(0);
    $fval.textContent = fmtFreq(_freq);
    $slider.addEventListener("input", () => {
      _freq = sliderToFreq(parseFloat($slider.value));
      $fval.textContent = fmtFreq(_freq);
    });
    $slider.addEventListener("change", () => {
      if (_slug) loadTree(_slug, _freq);
    });
  }

  // ── Slider biais (weight_exponent) + bouton "sans pondération" ───────────
  const $biasSlider = $("bias-slider"), $biasVal = $("bias-value");
  const $biasUniform = $("bias-uniform");

  // Valeur "dernière position du slider" (restaurée quand on sort du mode uniforme)
  let _sliderBias = 1.0;
  let _uniformMode = false;

  function _applyBias() {
    if (_uniformMode) {
      _bias = 0.0;  // 0 = signal au backend : tirage uniforme
      $biasSlider.disabled = true;
      $biasVal.textContent = "uniforme";
      $biasVal.classList.add("muted");
      $biasUniform.classList.add("active");
    } else {
      _bias = _sliderBias;
      $biasSlider.disabled = false;
      $biasVal.textContent = `×${_bias.toFixed(1)}`;
      $biasVal.classList.remove("muted");
      $biasUniform.classList.remove("active");
    }
    Training.setContext(_slug, _freq, _bias);
  }

  if ($biasSlider) {
    $biasSlider.value = 100;
    $biasSlider.addEventListener("input", () => {
      _sliderBias = parseFloat($biasSlider.value) / 100;
      _applyBias();
    });
  }
  if ($biasUniform) {
    $biasUniform.addEventListener("click", () => {
      _uniformMode = !_uniformMode;
      _applyBias();
    });
  }
  _applyBias();  // initial render

  // ── Bouton mute ──────────────────────────────────────────────────────────
  const $soundBtn = $("sound-toggle");
  if ($soundBtn) {
    // Lire la préférence stockée
    const stored = (() => {
      try { return localStorage.getItem("sound-enabled"); } catch(e) { return null; }
    })();
    let soundOn = stored === null ? true : stored === "true";
    if (window.Sounds) Sounds.setEnabled(soundOn);
    $soundBtn.classList.toggle("muted", !soundOn);
    $soundBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      if (window.Sounds) Sounds.setEnabled(soundOn);
      $soundBtn.classList.toggle("muted", !soundOn);
      try { localStorage.setItem("sound-enabled", String(soundOn)); } catch(e) {}
    });
  }

  // ── Switch de vue ────────────────────────────────────────────────────────

  function switchView(mode) {
    GameState.setMode(mode);
    $("nav-target")?.classList.toggle("active",   mode === "viewing");
    $("nav-training")?.classList.toggle("active", mode === "training");
    $("nav-correct")?.classList.toggle("active",  mode === "correct");
    $("panel-target")?.classList.toggle("active",   mode === "viewing");
    $("panel-training")?.classList.toggle("active", mode === "training");
    $("panel-correct")?.classList.toggle("active",  mode === "correct");

    if (mode === "training") {
      const st = GameState.get();
      if (!st.line.length) {
        Training.startNewLine();
      }
    }
  }

  $("nav-target")?.addEventListener("click",   () => switchView("viewing"));
  $("nav-training")?.addEventListener("click", () => switchView("training"));
  $("nav-correct")?.addEventListener("click",  () => switchView("correct"));

  // Événement custom utilisé par correct.js pour basculer vers un autre mode
  window.addEventListener("switch-view", (e) => {
    const mode = e.detail?.mode;
    if (mode) switchView(mode);
  });

  // ── Bouton "Revenir au début" du panel cible ─────────────────────────────
  $("target-back-btn")?.addEventListener("click", () => GameState.resetExploration());

  // ── Navigation clavier ←/→ (TOUJOURS active) ──────────────────────────────
  // En entraînement, la limite haute est le dernier coup VISIBLE
  // (playIndex - 1, ou playIndex si le coup courant est révélé).
  // En visualisation, pas de limite (toute la ligne explorée est accessible).

  function _maxVisibleIndex(state) {
    // En mode correct : selon la phase, on limite la navigation
    if (state.mode === "correct") {
      const g = state.correctGame;
      if (!g) return state.line.length - 1;
      if (state.correctionPhase === "correcting") {
        // En correction : on peut voir tous les coups AJOUTÉS par l'utilisateur,
        // mais pas les coups futurs de la partie originale
        // state.line contient déjà seulement les coups visibles (tronquée par appendCorrectionMove)
        return state.line.length - 1;
      }
      // Phase browsing : max = coup fautif (on peut voir son erreur)
      return (g.error_at !== null && g.error_at !== undefined)
        ? g.error_at
        : state.line.length - 1;
    }
    if (state.mode !== "training") return state.line.length - 1;
    if (state.lineDone) return state.line.length - 1;
    const revealedNow = state.expectedMove != null;
    return revealedNow ? state.playIndex : state.playIndex - 1;
  }

  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const st = GameState.get();
    const maxIdx = _maxVisibleIndex(st);

    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (st.navIndex < maxIdx) GameState.navForward();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      GameState.navBackward();
    } else if (e.key === "Home") {
      e.preventDefault();
      GameState.navToIndex(-1);
    } else if (e.key === "End") {
      e.preventDefault();
      GameState.navToIndex(maxIdx);
    }
  });

  // ── Lancement ────────────────────────────────────────────────────────────
  await loadRepertoires();
  switchView("viewing");
})();