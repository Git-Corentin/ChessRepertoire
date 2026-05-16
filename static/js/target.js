/**
 * target.js — Vue cible concentrique.
 *
 * 3 anneaux :
 *   - Centre   : coup courant (cliquer = reculer d'un cran)
 *   - Milieu   : coups disponibles depuis la position courante
 *                (taille proportionnelle à frequency)
 *   - Extérieur: prévisualisation du niveau suivant
 *
 * Pilotage
 * ────────
 * En visualisation :
 *   - L'utilisateur clique sur un segment → on émet setExplorationPath sur GameState
 *   - GameState met à jour line + navIndex → board.js met à jour le board
 *   - Le re-render de la cible se fait quand on reçoit "nav-change"
 *
 * En training : la cible est masquée (panel-target inactif), mais les calculs sont
 *               toujours valides — on peut donc la garder cohérente.
 */
"use strict";

const Target = (() => {

  // ── Constantes graphiques ─────────────────────────────────────────────────
  const CX = 230, CY = 230;
  const R_CENTER  = 50;
  const R_MID_IN  = 75;
  const R_MID_OUT = 155;
  const R_OUT_IN  = 165;
  const R_OUT_OUT = 220;
  const GAP_DEG = 1.5;
  const MIN_ARC = 4;

  const COL = {
    ourMid:    "#7b8cde",
    ourMidH:   "#9daae8",
    oppMid:    "#3a3c46",
    oppMidH:   "#4e505c",
    ourOut:    "#4a5299",
    oppOut:    "#2a2c34",
    centerBg:  "#1c1d21",
    centerH:   "#24252a",
    text:      "#e8e9ec",
    text2:     "#9a9ba4",
    text3:     "#5a5b64",
    bg:        "#0e0f11",
  };

  let _svg = null;
  let _bcEl = null;
  let _tooltip = null;

  // ── Init ──────────────────────────────────────────────────────────────────

  function init(svgEl, breadcrumbEl) {
    _svg = svgEl;
    _bcEl = breadcrumbEl;
    _tooltip = document.createElement("div");
    _tooltip.className = "target-tooltip";
    document.body.appendChild(_tooltip);
    GameState.subscribe(_onStateChange);
  }

  function _onStateChange(state, reason) {
    if (reason === "mode-change" || reason === "repertoire-change" || reason === "nav-change" ||
        reason === "training-update") {
      render();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Retourne les enfants à afficher dans l'anneau milieu.
   * - Si le navIndex est -1 (avant 1er coup) : enfants de la racine
   * - Sinon : enfants du nœud courant dans la ligne d'exploration
   */
  function _midChildren() {
    const st = GameState.get();
    if (!st.repertoire) return [];

    if (st.navIndex < 0) {
      return st.repertoire.children || [];
    }
    return st.line[st.navIndex]?.children || [];
  }

  /** Nœud courant (centre), null si à la racine. */
  function _currentNode() {
    const st = GameState.get();
    return st.navIndex >= 0 ? st.line[st.navIndex] : null;
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  function render() {
    if (!_svg) return;
    _hideTooltip();   // toujours cacher au re-render — sinon le tooltip "fantôme" reste
    _svg.innerHTML = "";
    _svg.setAttribute("viewBox", `0 0 ${CX*2} ${CY*2}`);

    const st = GameState.get();
    if (!st.repertoire) {
      _renderEmpty("Aucun répertoire chargé");
      _renderBreadcrumb();
      return;
    }

    const children = _midChildren();
    const isOurs   = children.length ? !!children[0].is_our_move : false;

    const midAngles   = _computeAngles(children);
    const outerAngles = _computeOuterAngles(midAngles);

    _renderGuides();
    _renderOuterRing(outerAngles, isOurs);
    _renderMidRing(midAngles, isOurs);
    _renderCenter();
    _renderBreadcrumb();
    _updateInfoPanel();
  }

  function _renderEmpty(msg) {
    const t = _svgEl("text", {
      x: CX, y: CY, "text-anchor": "middle", "dominant-baseline": "central",
      fill: COL.text3, "font-family": "var(--mono)", "font-size": "12",
    });
    t.textContent = msg;
    _svg.appendChild(t);
  }

  function _renderGuides() {
    for (const r of [R_CENTER, R_MID_IN, R_MID_OUT, R_OUT_IN, R_OUT_OUT]) {
      _svg.appendChild(_svgEl("circle", {
        cx: CX, cy: CY, r,
        fill: "none", stroke: "#2e2f35", "stroke-width": "0.5",
      }));
    }
  }

  function _renderMidRing(angles, isOurs) {
    const fillBase  = isOurs ? COL.ourMid  : COL.oppMid;
    const fillHover = isOurs ? COL.ourMidH : COL.oppMidH;

    for (const seg of angles) {
      const path = _svgEl("path", {
        d: _arcPath(R_MID_IN, R_MID_OUT, seg.start, seg.end),
        fill: fillBase, "fill-rule": "evenodd",
        stroke: COL.bg, "stroke-width": "1",
        cursor: "pointer", style: "transition: fill 150ms;",
      });
      path.addEventListener("mouseenter", e => {
        path.setAttribute("fill", fillHover);
        _showTooltip(e, seg.node);
      });
      path.addEventListener("mousemove", _moveTooltip);
      path.addEventListener("mouseleave", () => {
        path.setAttribute("fill", fillBase);
        _hideTooltip();
      });
      path.addEventListener("click", () => _navigateInto(seg.node));
      _svg.appendChild(path);

      // Label
      const span = seg.end - seg.start;
      if (span > 16) {
        const mid = (seg.start + seg.end) / 2;
        const r   = (R_MID_IN + R_MID_OUT) / 2;
        const [lx, ly] = _polar(r, mid);
        const t = _svgEl("text", {
          x: lx, y: ly, "text-anchor": "middle", "dominant-baseline": "central",
          fill: isOurs ? "#fff" : COL.text2,
          "font-family": "var(--mono)", "font-size": span > 35 ? "13" : "11",
          "font-weight": "500", "pointer-events": "none",
        });
        t.textContent = seg.node.move_san;
        _svg.appendChild(t);
      }
    }
  }

  function _renderOuterRing(angles, isOurs) {
    // Anneau extérieur = couleur opposée au milieu
    const fillBase = isOurs ? COL.oppOut : COL.ourOut;
    for (const seg of angles) {
      const path = _svgEl("path", {
        d: _arcPath(R_OUT_IN, R_OUT_OUT, seg.start, seg.end),
        fill: fillBase, "fill-rule": "evenodd",
        stroke: COL.bg, "stroke-width": "0.5",
        opacity: "0.55", cursor: "pointer",
        style: "transition: opacity 150ms;",
      });
      path.addEventListener("mouseenter", e => {
        path.setAttribute("opacity", "0.95");
        _showTooltip(e, seg.node);
      });
      path.addEventListener("mousemove", _moveTooltip);
      path.addEventListener("mouseleave", () => {
        path.setAttribute("opacity", "0.55");
        _hideTooltip();
      });
      // Clic = jouer les DEUX coups : d'abord celui de l'anneau milieu (parentNode),
      // puis celui de l'anneau extérieur (seg.node lui-même).
      path.addEventListener("click", () => {
        _navigateInto(seg.parentNode);
        // _navigateInto recompose la ligne autour de navIndex, on enchaîne directement.
        _navigateInto(seg.node);
      });
      _svg.appendChild(path);

      const span = seg.end - seg.start;
      if (span > 12) {
        const mid = (seg.start + seg.end) / 2;
        const r   = (R_OUT_IN + R_OUT_OUT) / 2;
        const [lx, ly] = _polar(r, mid);
        const t = _svgEl("text", {
          x: lx, y: ly, "text-anchor": "middle", "dominant-baseline": "central",
          fill: COL.text3, "font-family": "var(--mono)", "font-size": "9",
          "pointer-events": "none", opacity: "0.8",
        });
        t.textContent = seg.node.move_san;
        _svg.appendChild(t);
      }
    }
  }

  function _renderCenter() {
    const cur = _currentNode();
    const hasParent = cur !== null;

    const circle = _svgEl("circle", {
      cx: CX, cy: CY, r: R_CENTER - 2,
      fill: COL.centerBg, stroke: "#2e2f35", "stroke-width": "1",
      cursor: hasParent ? "pointer" : "default",
      style: "transition: fill 150ms;",
    });
    if (hasParent) {
      circle.addEventListener("mouseenter", () => circle.setAttribute("fill", COL.centerH));
      circle.addEventListener("mouseleave", () => circle.setAttribute("fill", COL.centerBg));
      circle.addEventListener("click", _navigateBack);
    }
    _svg.appendChild(circle);

    if (cur) {
      const moveTxt = _svgEl("text", {
        x: CX, y: CY - 8, "text-anchor": "middle", "dominant-baseline": "central",
        fill: cur.is_our_move ? COL.ourMid : COL.text2,
        "font-family": "var(--mono)", "font-size": "16", "font-weight": "500",
        "pointer-events": "none",
      });
      moveTxt.textContent = cur.move_san;
      _svg.appendChild(moveTxt);

      const pct = Math.round((cur.cumulative_frequency || 0) * 100);
      const freqTxt = _svgEl("text", {
        x: CX, y: CY + 12, "text-anchor": "middle", "dominant-baseline": "central",
        fill: COL.text3, "font-family": "var(--mono)", "font-size": "10",
        "pointer-events": "none",
      });
      freqTxt.textContent = `${pct}%`;
      _svg.appendChild(freqTxt);

      const arrow = _svgEl("text", {
        x: CX, y: CY + 30, "text-anchor": "middle", "dominant-baseline": "central",
        fill: COL.text3, "font-size": "11", "pointer-events": "none",
      });
      arrow.textContent = "↑";
      _svg.appendChild(arrow);
    } else {
      const dot = _svgEl("circle", { cx: CX, cy: CY, r: 5, fill: COL.text3, "pointer-events": "none" });
      _svg.appendChild(dot);
    }
  }

  function _renderBreadcrumb() {
    if (!_bcEl) return;
    _bcEl.innerHTML = "";
    const st = GameState.get();
    if (!st.repertoire || st.line.length === 0) {
      const span = document.createElement("span");
      span.textContent = "Position de départ";
      span.style.color = "var(--text3)";
      _bcEl.appendChild(span);
      return;
    }

    const root = document.createElement("span");
    root.className = "bc-move";
    root.textContent = "◉";
    root.title = "Retour au début";
    root.addEventListener("click", () => GameState.resetExploration());
    _bcEl.appendChild(root);

    for (let i = 0; i <= st.navIndex; i++) {
      const sep = document.createElement("span");
      sep.className = "bc-sep";
      sep.textContent = " › ";
      _bcEl.appendChild(sep);

      const n = st.line[i];
      const mv = document.createElement("span");
      mv.className = "bc-move";
      mv.textContent = n.move_san;
      mv.style.color = n.is_our_move ? "var(--accent)" : "var(--text2)";
      const idx = i;
      mv.addEventListener("click", () => GameState.navToIndex(idx));
      _bcEl.appendChild(mv);
    }
  }

  function _updateInfoPanel() {
    const cur = _currentNode();

    // Helper : alimente un trio d'éléments
    function _setInfo(moveId, freqLocalId, freqCumId, evalId) {
      const $move = document.getElementById(moveId);
      if (!$move) return;
      if (!cur) {
        $move.textContent = "—";
        if (freqLocalId) document.getElementById(freqLocalId).textContent = "—";
        if (freqCumId)   document.getElementById(freqCumId).textContent = "—";
        if (evalId)      document.getElementById(evalId).textContent = "—";
        return;
      }
      const localPct = Math.round((cur.frequency || 0) * 100 * 10) / 10;
      const cumPct   = Math.round((cur.cumulative_frequency || 0) * 100 * 10) / 10;
      const ev = cur.stockfish_eval;
      const evStr = ev != null ? `${ev > 0 ? "+" : ""}${(ev/100).toFixed(2)}` : "—";

      $move.textContent = cur.move_san;
      if (freqLocalId) document.getElementById(freqLocalId).textContent = `${localPct}%`;
      if (freqCumId)   document.getElementById(freqCumId).textContent   = `${cumPct}%`;
      if (evalId)      document.getElementById(evalId).textContent      = evStr;
    }

    // Cible (visualisation)
    _setInfo("ti-move", null, "ti-freq", "ti-eval");
    // Training (panel) — pas d'éval (souvent absente pour les coups adverses)
    _setInfo("ti-move-tr", "ti-freq-local-tr", "ti-freq-cum-tr", null);
  }

  // ── Navigation depuis la cible → GameState ───────────────────────────────

  function _navigateInto(node) {
    if (!node) return;
    const st = GameState.get();
    // Construire le nouveau chemin = ligne actuelle (jusqu'à navIndex inclus) + node
    const newPath = st.line.slice(0, st.navIndex + 1).concat([node]);
    GameState.setExplorationPath(newPath);
  }

  function _navigateBack() {
    GameState.navBackward();
  }

  // ── Tooltip ──────────────────────────────────────────────────────────────

  function _showTooltip(e, node) {
    const pct  = Math.round((node.frequency || 0) * 100);
    const cpct = Math.round((node.cumulative_frequency || 0) * 100);
    const ev = node.stockfish_eval != null
      ? ` · ${node.stockfish_eval > 0 ? "+" : ""}${(node.stockfish_eval/100).toFixed(2)}` : "";
    _tooltip.textContent = `${node.move_san}  ${pct}% local · ${cpct}% cumulé${ev}`;
    _tooltip.classList.add("visible");
    _moveTooltip(e);
  }
  function _moveTooltip(e) {
    _tooltip.style.left = `${e.clientX + 14}px`;
    _tooltip.style.top  = `${e.clientY - 30}px`;
  }
  function _hideTooltip() { _tooltip.classList.remove("visible"); }

  // ── Geometry helpers ─────────────────────────────────────────────────────

  function _polar(r, deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  }

  function _arcPath(r1, r2, startDeg, endDeg) {
    const span = endDeg - startDeg;

    // Cas spécial : anneau complet → on découpe en 2 demi-cercles
    // pour éviter le bug SVG où un arc de 360° dégénère.
    // On utilise fill-rule:evenodd via deux cercles.
    if (span >= 359.5) {
      // Path = grand cercle extérieur + petit cercle intérieur (sens inverse)
      // qui se "creuse" via evenodd.
      return `M ${CX-r2} ${CY} A ${r2} ${r2} 0 1 1 ${CX+r2} ${CY} A ${r2} ${r2} 0 1 1 ${CX-r2} ${CY} Z `
           + `M ${CX-r1} ${CY} A ${r1} ${r1} 0 1 0 ${CX+r1} ${CY} A ${r1} ${r1} 0 1 0 ${CX-r1} ${CY} Z`;
    }

    const [x1o, y1o] = _polar(r2, startDeg);
    const [x2o, y2o] = _polar(r2, endDeg);
    const [x1i, y1i] = _polar(r1, endDeg);
    const [x2i, y2i] = _polar(r1, startDeg);
    const large = span > 180 ? 1 : 0;
    return `M ${x1o} ${y1o} A ${r2} ${r2} 0 ${large} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${r1} ${r1} 0 ${large} 0 ${x2i} ${y2i} Z`;
  }

  function _computeAngles(children) {
    if (!children.length) return [];
    if (children.length === 1) return [{ node: children[0], start: 0, end: 360 }];

    const total = children.reduce((s, c) => s + (c.frequency || 0), 0);
    const totalGap = GAP_DEG * children.length;
    const available = 360 - totalGap;

    let cursor = 0;
    return children.map(child => {
      const frac = total > 0 ? (child.frequency || 0) / total : 1 / children.length;
      const span = Math.max(MIN_ARC, frac * available);
      const seg = { node: child, start: cursor, end: cursor + span };
      cursor = seg.end + GAP_DEG;
      return seg;
    });
  }

  function _computeOuterAngles(midAngles) {
    const result = [];
    for (const seg of midAngles) {
      const children = seg.node.children || [];
      if (!children.length) continue;
      const parentSpan = seg.end - seg.start;
      if (children.length === 1) {
        result.push({ node: children[0], start: seg.start, end: seg.end, parentNode: seg.node });
        continue;
      }
      const total = children.reduce((s, c) => s + (c.frequency || 0), 0);
      const totalGap = (GAP_DEG * 0.5) * children.length;
      const available = parentSpan - totalGap;
      let cursor = seg.start;
      for (const child of children) {
        const frac = total > 0 ? (child.frequency || 0) / total : 1 / children.length;
        const span = Math.max(1.5, frac * available);
        result.push({ node: child, start: cursor, end: cursor + span, parentNode: seg.node });
        cursor += span + GAP_DEG * 0.5;
      }
    }
    return result;
  }

  function _svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  return { init, render };
})();

window.Target = Target;