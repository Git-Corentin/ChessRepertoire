"""
filter.py
─────────
Élagage de l'arbre par cumulative_frequency.

Règle : on conserve un nœud si et seulement si sa cumulative_frequency
est supérieure ou égale au seuil demandé. On élimine récursivement tous
les sous-arbres dont la racine ne passe pas le seuil.

Pourquoi cumulative_frequency et pas frequency locale ?
  La cumulative_frequency représente la probabilité que cette ligne
  apparaisse dans une vraie partie (produit des fréquences depuis la racine).
  C'est le critère pertinent pour "est-ce que cette ligne vaut la peine
  d'être apprise ?" — une ligne locale à 80% sur une branche qui n'arrive
  qu'une fois pour mille est moins prioritaire qu'une ligne à 10% sur
  une branche très fréquente.
"""

from __future__ import annotations
from typing import Optional
import copy


# ── API publique ────────────────────────────────────────────────────────────────

def filter_tree(
    children: list[dict],
    threshold: float,
    *,
    _is_root: bool = True,
) -> list[dict]:
    """
    Retourne une copie élagage de l'arbre.

    Un nœud est conservé si sa cumulative_frequency >= threshold.
    Ses enfants sont filtrés récursivement avec le même seuil.

    Les nœuds racines (depth=0) ont pour cumulative_frequency leur
    fréquence locale — ils sont traités comme les autres.
    """
    result = []
    for node in children:
        cum_freq = node.get("cumulative_frequency", 0.0)

        # Les nœuds à cumulative_frequency = 0.0 sont les "coups finaux"
        # ajoutés hors seuil en fin de ligne par le générateur.
        # On les inclut toujours pour ne pas tronquer la dernière réponse.
        if cum_freq == 0.0:
            result.append(_shallow_copy_with_children(node, []))
            continue

        if cum_freq < threshold:
            continue  # nœud élagué avec toute sa descendance

        filtered_children = filter_tree(node.get("children", []), threshold, _is_root=False)
        result.append(_shallow_copy_with_children(node, filtered_children))

    return result


def count_lines(children: list[dict]) -> int:
    """
    Compte le nombre de lignes terminales dans l'arbre filtré.
    Une ligne = un chemin de la racine à une feuille.
    """
    if not children:
        return 1  # feuille = une ligne
    total = 0
    for node in children:
        total += count_lines(node.get("children", []))
    return total


def collect_lines(
    children: list[dict],
    current_line: Optional[list[dict]] = None,
) -> list[list[dict]]:
    """
    Retourne toutes les lignes complètes de l'arbre sous forme de listes de nœuds.
    Chaque ligne va de la racine à une feuille.

    Utilisé par le TrainingEngine pour choisir une ligne pondérée.
    """
    if current_line is None:
        current_line = []

    if not children:
        return [current_line] if current_line else []

    lines = []
    for node in children:
        line = collect_lines(node.get("children", []), current_line + [node])
        lines.extend(line)
    return lines


def line_cumulative_weight(line: list[dict]) -> float:
    """
    Poids d'une ligne = cumulative_frequency de sa feuille.
    C'est la probabilité que cette ligne apparaisse en partie réelle.

    Si la feuille a cumulative_frequency=0.0 (coup final hors seuil),
    on remonte au dernier nœud avec une fréquence non nulle.
    """
    for node in reversed(line):
        cf = node.get("cumulative_frequency", 0.0)
        if cf > 0.0:
            return cf
    return 0.0


# ── Helpers internes ────────────────────────────────────────────────────────────

def _shallow_copy_with_children(node: dict, filtered_children: list[dict]) -> dict:
    """Copie superficielle d'un nœud en remplaçant ses enfants."""
    n = dict(node)
    n["children"] = filtered_children
    return n
