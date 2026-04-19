/**
 * tree.js — Arbre déroulant latéral.
 *
 * Pilotage
 * ────────
 * - L'utilisateur clique sur un nœud → on construit le chemin complet
 *   depuis la racine et on appelle GameState.setExplorationPath
 * - L'arbre re-renderise quand le répertoire change.
 * - Chaque nœud du DOM connaît son chemin (via dataset).
 */
"use strict";

const Tree = (() => {

  let _container = null;
  let _selectedHeader = null;
  let _selectedMove   = null;
  let _fenIndex = {};   // { fenNorm: count } pour transpositions

  // ── Init ──────────────────────────────────────────────────────────────────

  function init(containerEl) {
    _container = containerEl;
    GameState.subscribe(_onStateChange);
  }

  function _onStateChange(state, reason) {
    if (reason === "repertoire-change" || reason === "mode-change") {
      _rebuildIndex();
      render();
    }
  }

  function _rebuildIndex() {
    _fenIndex = {};
    const st = GameState.get();
    const children = st.repertoire?.children || [];
    _walk(children, n => {
      const k = _normFen(n.fen_after);
      _fenIndex[k] = (_fenIndex[k] || 0) + 1;
    });
  }

  function _walk(nodes, fn) {
    for (const n of nodes) {
      fn(n);
      _walk(n.children || [], fn);
    }
  }

  function _normFen(fen) {
    return fen ? fen.split(" ").slice(0, 4).join(" ") : "";
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  function render() {
    if (!_container) return;
    _container.innerHTML = "";
    _selectedHeader = null;
    _selectedMove = null;

    const st = GameState.get();
    const children = st.repertoire?.children || [];
    if (!children.length) {
      _container.innerHTML = '<div style="padding:24px 16px;color:var(--text3);font-size:12px;">Aucune donnée</div>';
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "fade-in";
    _renderNodes(children, wrapper, 0, []);
    _container.appendChild(wrapper);
  }

  function _renderNodes(nodes, parent, depth, parentPath) {
    for (let i = 0; i < nodes.length; i++) {
      parent.appendChild(_buildNode(nodes[i], depth, parentPath.concat([nodes[i]])));
    }
  }

  function _buildNode(node, depth, path) {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node";

    const hasChildren = (node.children || []).length > 0;
    let isOpen = depth < 2;

    const header = document.createElement("div");
    header.className = "tree-node-header";

    const indent = document.createElement("div");
    indent.style.paddingLeft = `${8 + depth * 14}px`;
    indent.style.display = "flex";
    indent.style.alignItems = "center";

    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", `tree-chevron${!hasChildren ? " leaf" : isOpen ? " open" : ""}`);
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.innerHTML = `<polyline points="5,3 11,8 5,13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    indent.appendChild(chevron);
    header.appendChild(indent);

    const moveEl = document.createElement("span");
    moveEl.className = `tree-move ${node.is_our_move ? "ours" : "theirs"}`;
    moveEl.textContent = node.move_san;
    header.appendChild(moveEl);

    if (_isTransposition(node)) {
      const badge = document.createElement("span");
      badge.className = "tree-transpo";
      badge.textContent = "≡";
      badge.title = "Position atteinte par plusieurs chemins";
      header.appendChild(badge);
    }

    const pct = Math.round((node.cumulative_frequency || 0) * 100);
    if (pct > 0) {
      const freq = document.createElement("span");
      freq.className = "tree-freq";
      freq.textContent = `${pct}%`;
      header.appendChild(freq);
    }

    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-children";
    childrenEl.style.display = isOpen ? "block" : "none";
    if (hasChildren) {
      _renderNodes(node.children, childrenEl, depth + 1, path);
    }

    // Click handler
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      // Toggle expand
      if (hasChildren) {
        isOpen = !isOpen;
        childrenEl.style.display = isOpen ? "block" : "none";
        chevron.classList.toggle("open", isOpen);
      }
      // Selection
      if (_selectedHeader) _selectedHeader.classList.remove("active");
      if (_selectedMove)   _selectedMove.classList.remove("sel");
      header.classList.add("active");
      moveEl.classList.add("sel");
      _selectedHeader = header;
      _selectedMove   = moveEl;

      // Mettre à jour le GameState avec ce chemin
      GameState.setExplorationPath(path);
    });

    wrapper.appendChild(header);
    wrapper.appendChild(childrenEl);
    return wrapper;
  }

  function _isTransposition(node) {
    return (_fenIndex[_normFen(node.fen_after)] || 0) > 1;
  }

  return { init, render };
})();

window.Tree = Tree;