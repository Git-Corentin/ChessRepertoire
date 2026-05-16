/**
 * tree.js — Arbre de répertoire avec scroll horizontal + vertical.
 *
 * Structure : arbre vertical classique avec indentation par profondeur.
 * Scroll horizontal pour les coups profonds.
 * Le nœud courant est mis en évidence et scrollé automatiquement.
 * Transpositions : ≡ avec tooltip.
 * Sync inverse : clic sur board/clavier → surligne le nœud dans l'arbre.
 */
"use strict";

const Tree = (() => {
  let _container   = null;
  let _tooltip     = null;
  let _fenCount    = {};
  let _fenPaths    = {};
  let _headerByFen = {};
  let _currentHeader = null;

  function init(containerEl) {
    _container = containerEl;
    _tooltip = document.createElement("div");
    _tooltip.className = "target-tooltip";
    document.body.appendChild(_tooltip);
    GameState.subscribe(_onStateChange);
  }

  function _onStateChange(state, reason) {
    if (reason === "repertoire-change") {
      _buildIndex(state.repertoire?.children || []);
      render();
    } else if (["nav-change","mode-change","correction-cleared"].includes(reason)) {
      if (state.mode === "viewing") _syncToCurrentPath();
    }
  }

  function _buildIndex(children) {
    _fenCount = {}; _fenPaths = {};
    _walk(children, [], (node, path) => {
      const k = _normFen(node.fen_after);
      _fenCount[k] = (_fenCount[k] || 0) + 1;
      (_fenPaths[k] = _fenPaths[k] || []).push(path.map(n => n.move_san));
    });
  }

  function _walk(nodes, prefix, fn) {
    for (const n of nodes) {
      const p = [...prefix, n];
      fn(n, p);
      _walk(n.children || [], p, fn);
    }
  }

  function _normFen(fen) { return (fen || "").split(" ").slice(0,4).join(" "); }

  // ── Rendu ────────────────────────────────────────────────────────────────

  function render() {
    if (!_container) return;
    _container.innerHTML = "";
    _headerByFen = {};
    _currentHeader = null;

    const st = GameState.get();
    const children = st.repertoire?.children || [];
    if (!children.length) {
      _container.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px;">Aucune donnée</div>';
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "tree-body fade-in";
    _renderNodes(children, wrapper, 0, []);
    _container.appendChild(wrapper);
    _syncToCurrentPath();
  }

  function _renderNodes(nodes, parent, depth, parentPath) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const path = [...parentPath, node];
      const isLast = i === nodes.length - 1;
      _buildEntry(node, parent, depth, path, isLast);
    }
  }

  function _buildEntry(node, parent, depth, path, isLast) {
    // Ligne = header + (enfants si plusieurs alternatives, ou inline si unique)
    const entry = document.createElement("div");
    entry.className = "tree-entry";

    const header = document.createElement("div");
    header.className = "tree-node-header";
    header.style.paddingLeft = `${8 + depth * 18}px`;

    // Indicateur de continuation (trait vertical + crochet)
    const connector = document.createElement("span");
    connector.className = "tree-connector";
    header.appendChild(connector);

    // Numéro + coup
    const moveNum = Math.floor(depth / 2) + 1;
    const isWhite = depth % 2 === 0;

    const moveEl = document.createElement("span");
    moveEl.className = `tree-move ${node.is_our_move ? "ours" : "theirs"}`;
    if (isWhite) {
      moveEl.textContent = `${moveNum}. ${node.move_san}`;
    } else {
      // Pour le coup noir, afficher le numéro seulement si c'est le début d'une ligne
      moveEl.textContent = depth === 1 ? `${moveNum}… ${node.move_san}` : node.move_san;
    }
    header.appendChild(moveEl);

    // Fréquence
    const pct = Math.round((node.cumulative_frequency || 0) * 100);
    if (pct > 0) {
      const freqEl = document.createElement("span");
      freqEl.className = "tree-freq";
      freqEl.textContent = `${pct}%`;
      header.appendChild(freqEl);
    }

    // Transposition
    const fenK = _normFen(node.fen_after);
    if ((_fenCount[fenK] || 0) > 1) {
      const badge = document.createElement("span");
      badge.className = "tree-transpo";
      badge.textContent = "≡";
      const myPath = path.map(n => n.move_san).join(" ");
      const others = (_fenPaths[fenK] || [])
        .filter(p => p.join(" ") !== myPath).slice(0, 3).map(p => p.join(" "));
      badge.addEventListener("mouseenter", e => {
        _tooltip.textContent = others.length
          ? `Aussi via : ${others.join(" • ")}`
          : "Transposition";
        _tooltip.classList.add("visible"); _moveTooltip(e);
      });
      badge.addEventListener("mousemove", _moveTooltip);
      badge.addEventListener("mouseleave", () => _tooltip.classList.remove("visible"));
      header.appendChild(badge);
    }

    header.addEventListener("click", () => GameState.setExplorationPath(path));
    header.addEventListener("mouseenter", () => _highlightBranch(path, true));
    header.addEventListener("mouseleave",  () => _highlightBranch(path, false));

    if (!_headerByFen[fenK]) _headerByFen[fenK] = [];
    _headerByFen[fenK].push({ header, path });

    entry.appendChild(header);

    // Enfants
    const children = node.children || [];
    if (children.length > 0) {
      const childrenEl = document.createElement("div");
      childrenEl.className = "tree-children";
      _renderNodes(children, childrenEl, depth + 1, path);
      entry.appendChild(childrenEl);
    }

    parent.appendChild(entry);
  }

  // Surligne tous les nœuds du chemin survolé
  function _highlightBranch(path, on) {
    for (const node of path) {
      const fenK = _normFen(node.fen_after);
      (_headerByFen[fenK] || []).forEach(({ header, path: hPath }) => {
        // Ne surligner que les headers de ce chemin précis
        const hSans = hPath.map(n => n.move_san).join(" ");
        const pSans = path.map(n => n.move_san).join(" ");
        if (hSans === pSans || pSans.startsWith(hSans)) {
          header.classList.toggle("hover-branch", on);
        }
      });
    }
  }

  // ── Sync inverse ─────────────────────────────────────────────────────────

  function _syncToCurrentPath() {
    const st = GameState.get();
    if (_currentHeader) { _currentHeader.classList.remove("current"); _currentHeader = null; }
    if (st.mode !== "viewing" || st.navIndex < 0) return;
    const node = st.line[st.navIndex];
    if (!node) return;
    const fenK = _normFen(node.fen_after);
    const matches = _headerByFen[fenK];
    if (!matches?.length) return;
    const lineSans = st.line.slice(0, st.navIndex + 1).map(n => n.move_san).join(" ");
    let best = matches[0];
    for (const m of matches) {
      if (m.path.map(n => n.move_san).join(" ") === lineSans) { best = m; break; }
    }
    best.header.classList.add("current");
    _currentHeader = best.header;
    best.header.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  function _moveTooltip(e) {
    _tooltip.style.left = `${e.clientX + 14}px`;
    _tooltip.style.top  = `${e.clientY - 30}px`;
  }

  return { init, render };
})();

window.Tree = Tree;