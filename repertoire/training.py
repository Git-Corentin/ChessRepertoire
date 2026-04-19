"""
training.py
───────────
Moteur d'entraînement.

Architecture
────────────
La session contient :
  current_line   : la ligne tirée au sort (liste complète de nœuds, du début à la feuille)
  current_index  : index dans cette ligne du PROCHAIN coup que l'utilisateur doit jouer
                   (pointe toujours sur un nœud is_our_move=True, sauf si line_done)
  errors         : indices des coups où l'utilisateur s'est trompé
  revealed       : indices des coups révélés via "indice"
  line_done      : True quand on a fini la ligne (ou qu'il n'y a plus de coup à nous)

Le frontend reçoit la ligne ENTIÈRE (avec move_uci, fen_after pour chaque coup).
Il décide de la révélation visuelle. Cela permet :
  - Navigation clavier en avant/arrière sans appel API
  - Affichage de la position immédiatement
  - État cohérent et simple

Erreurs : on enregistre l'erreur, on RÉVÈLE le coup attendu, et on demande à
l'utilisateur de rejouer le bon coup. La ligne ne saute pas.

Coups adverses : la ligne entière est pré-tirée au sort proportionnellement à
cumulative_frequency. Pendant la ligne, les coups adverses suivent juste cette
ligne (déjà tirée), donc pas de nouveau tirage en cours de partie.
"""

from __future__ import annotations

import random
from typing import Optional

from .filter import collect_lines, line_cumulative_weight


# ── Sélection de ligne ──────────────────────────────────────────────────────────

def select_line(
    filtered_children: list[dict],
    lock_node_path: Optional[list[int]] = None,
    lock_fen: Optional[str] = None,
    weight_exponent: float = 1.0,
) -> Optional[tuple[list[dict], int]]:
    """
    Sélectionne une ligne au hasard, pondérée par cumulative_frequency^weight_exponent.

    Retourne un tuple (line, prefix_len) :
      - line        : liste complète des nœuds (préfixe du verrou + suffixe tiré)
      - prefix_len  : nombre de coups en préfixe (0 si pas de verrou)

    weight_exponent contrôle le biais vers les lignes fréquentes :
      - 1.0 (défaut) : tirage strictement proportionnel à la fréquence
      - 2.0          : amplifie le poids des lignes fréquentes
      - 0.0          : pondération uniforme (toutes lignes équiprobables)

    Si lock_fen est fourni, on cherche le path correspondant dans l'arbre.
    Sinon si lock_node_path est fourni, on l'utilise directement.
    """
    # Si lock_fen sans path, chercher le path
    if lock_fen and not lock_node_path:
        lock_node_path = find_node_path_by_fen(filtered_children, lock_fen)

    if lock_node_path:
        subtree = _subtree_at_lock(filtered_children, lock_node_path)
        prefix  = _prefix_at_lock(filtered_children, lock_node_path)
    else:
        subtree = filtered_children
        prefix  = []

    prefix_len = len(prefix)

    if not subtree:
        return (prefix, prefix_len) if prefix else None

    lines = collect_lines(subtree)
    if not lines:
        return (prefix, prefix_len) if prefix else None

    raw_weights = [line_cumulative_weight(line) for line in lines]
    if weight_exponent <= 0.0:
        # Mode "sans pondération" : tirage uniforme parmi les lignes disponibles
        weights = [1.0] * len(lines)
    else:
        weights = [w ** weight_exponent for w in raw_weights]
    total = sum(weights)

    if total == 0:
        suffix = random.choice(lines)
    else:
        r = random.uniform(0, total)
        cumul = 0.0
        suffix = lines[-1]
        for line, w in zip(lines, weights):
            cumul += w
            if r <= cumul:
                suffix = line
                break

    return (prefix + suffix, prefix_len)


def find_node_path_by_fen(children: list[dict], fen: str) -> Optional[list[int]]:
    """
    Cherche dans l'arbre le premier nœud dont fen_after correspond au FEN demandé.
    On compare en normalisant (sans les compteurs de coups).
    Retourne le chemin d'index, ou None si introuvable.
    """
    target = _norm_fen(fen)

    def _search(nodes, path):
        for i, node in enumerate(nodes):
            cur_path = path + [i]
            if _norm_fen(node.get("fen_after", "")) == target:
                return cur_path
            sub = _search(node.get("children", []), cur_path)
            if sub is not None:
                return sub
        return None

    return _search(children, [])


def _norm_fen(fen: str) -> str:
    """FEN sans compteurs de demi-coup et de coup complet (pour transpositions)."""
    if not fen:
        return ""
    return " ".join(fen.split(" ")[:4])


def _subtree_at_lock(children: list[dict], path: list[int]) -> list[dict]:
    current = children
    for idx in path:
        if idx >= len(current):
            return []
        current = current[idx].get("children", [])
    return current


def _prefix_at_lock(children: list[dict], path: list[int]) -> list[dict]:
    """Reconstitue les nœuds du chemin du verrou (pour les inclure dans la ligne)."""
    prefix = []
    current = children
    for idx in path:
        if idx >= len(current):
            break
        node = current[idx]
        prefix.append(node)
        current = node.get("children", [])
    return prefix


# ── État de session ─────────────────────────────────────────────────────────────

def init_training_state(
    slug: str,
    filtered_children: list[dict],
    frequency_threshold: float,
    lock_fen: Optional[str] = None,
    lock_node_path: Optional[list[int]] = None,
    weight_exponent: float = 1.0,
) -> Optional[dict]:
    """Initialise une nouvelle session avec une ligne tirée au sort."""
    result = select_line(filtered_children, lock_node_path, lock_fen, weight_exponent)
    if not result:
        return None
    line, prefix_len = result

    # On cherche le premier coup à nous APRÈS le préfixe du verrou —
    # les coups du préfixe sont considérés comme déjà joués.
    first_our_idx = next(
        (i for i, n in enumerate(line)
         if i >= prefix_len and n.get("is_our_move", False)),
        None
    )

    return {
        "repertoire_slug": slug,
        "frequency_threshold": frequency_threshold,
        "lock_fen": lock_fen,
        "lock_node_path": lock_node_path or [],
        "current_line": _serialize_line(line),
        "current_index": first_our_idx if first_our_idx is not None else len(line),
        "prefix_len": prefix_len,
        "errors": [],
        "revealed": [],
        "line_done": first_our_idx is None,
    }


def _serialize_line(line: list[dict]) -> list[dict]:
    """Garde tous les champs nécessaires au frontend pour chaque nœud."""
    return [
        {
            "move_uci": n["move_uci"],
            "move_san": n["move_san"],
            "fen_after": n["fen_after"],
            "is_our_move": n.get("is_our_move", False),
            "frequency": n.get("frequency", 0.0),
            "cumulative_frequency": n.get("cumulative_frequency", 0.0),
            "stockfish_eval": n.get("stockfish_eval"),
        }
        for n in line
    ]


# ── Avancement ──────────────────────────────────────────────────────────────────

def advance_state(state: dict, played_uci: str) -> dict:
    """
    Traite un coup joué par l'utilisateur.
      - Coup correct → avance current_index au prochain coup à nous
                        (saute par-dessus les coups adverses suivants)
      - Coup faux    → enregistre l'erreur, révèle le bon coup, n'avance pas

    Accepte les deux conventions UCI pour le roque (standard et Chess960).
    """
    line = state["current_line"]
    idx  = state["current_index"]

    if idx >= len(line):
        state["line_done"] = True
        return state

    expected = line[idx]
    if not _uci_matches(played_uci, expected["move_uci"]):
        if idx not in state["errors"]:
            state["errors"].append(idx)
        return state

    # Coup correct → on avance jusqu'au prochain coup à nous
    next_idx = _find_next_our_move(line, idx + 1)
    if next_idx is None:
        state["current_index"] = len(line)
        state["line_done"] = True
    else:
        state["current_index"] = next_idx

    return state


# Équivalences UCI du roque : standard (roi sur case cible) ↔ Chess960 (roi sur tour)
_CASTLING_EQUIV = {
    "e1g1": "e1h1", "e1h1": "e1g1",  # petit roque blanc
    "e1c1": "e1a1", "e1a1": "e1c1",  # grand roque blanc
    "e8g8": "e8h8", "e8h8": "e8g8",  # petit roque noir
    "e8c8": "e8a8", "e8a8": "e8c8",  # grand roque noir
}


def _uci_matches(played: str, expected: str) -> bool:
    """Compare deux UCI, en acceptant les deux conventions de roque."""
    if played == expected:
        return True
    # Les deux formes de roque sont équivalentes
    return _CASTLING_EQUIV.get(played) == expected


def _find_next_our_move(line: list[dict], from_idx: int) -> Optional[int]:
    for i in range(from_idx, len(line)):
        if line[i].get("is_our_move", False):
            return i
    return None


# ── Sérialisation pour le frontend ─────────────────────────────────────────────

def state_to_api(state: dict) -> dict:
    """
    Expose la ligne complète au frontend.
    Le coup attendu n'est explicitement renvoyé QUE s'il a été révélé
    (erreur ou indice) — sinon le frontend l'affiche par lui-même via la ligne.
    """
    line = state["current_line"]
    idx  = state["current_index"]
    errors   = state["errors"]
    revealed = state["revealed"]
    done = state["line_done"]

    expected_move = None
    if not done and idx < len(line):
        if (idx in errors) or (idx in revealed):
            expected_move = {
                "uci": line[idx]["move_uci"],
                "san": line[idx]["move_san"],
            }

    return {
        "line_done": done,
        "current_index": idx,
        "prefix_len":    state.get("prefix_len", 0),
        "errors": errors,
        "revealed": revealed,
        "expected_move": expected_move,
        "line": [
            {
                "move_uci":    n["move_uci"],
                "move_san":    n["move_san"],
                "fen_after":   n["fen_after"],
                "is_our_move": n["is_our_move"],
                "frequency":            n.get("frequency", 0.0),
                "cumulative_frequency": n.get("cumulative_frequency", 0.0),
                "stockfish_eval":       n.get("stockfish_eval"),
                "has_error":   i in errors,
                "was_revealed": i in revealed,
            }
            for i, n in enumerate(line)
        ],
    }