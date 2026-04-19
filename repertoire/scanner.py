"""
scanner.py
──────────
Scanne REPERTOIRES_DIR et retourne les métadonnées + arbres des répertoires JSON.

Chaque fichier JSON est produit par le script de génération (OpeningTree.to_dict()).
On distingue deux niveaux de lecture :
  - léger  : métadonnées seules (pour la liste de sélection)
  - complet : arbre entier chargé en mémoire (pour visualisation / entraînement)
"""

import json
import hashlib
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from django.conf import settings


# ── Structure de données ────────────────────────────────────────────────────────

@dataclass
class RepertoireMeta:
    """Métadonnées extraites de l'en-tête du JSON, sans charger l'arbre."""
    slug: str                        # nom du fichier sans extension
    filename: str                    # nom de fichier complet
    opening_name: str
    color: str                       # "white" | "black"
    elo_range: str                   # ex. "1000-1200"
    frequency_threshold: float       # seuil utilisé à la génération
    initial_moves: list[str]         # coups initiaux en SAN
    w_winrate: float
    w_stockfish: float
    w_frequency: float
    w_consistency: float
    node_count: int                  # nombre total de nœuds (calculé à la lecture)
    complete: bool                   # False si la génération a été interrompue


@dataclass
class RepertoireTree:
    """Arbre complet chargé en mémoire."""
    meta: RepertoireMeta
    root_fen: str
    children: list[dict]             # nœuds bruts du JSON (on garde la structure dict)


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _count_nodes(nodes: list[dict]) -> int:
    """Compte récursivement tous les nœuds de l'arbre."""
    count = 0
    for node in nodes:
        count += 1
        count += _count_nodes(node.get("children", []))
    return count


def _all_complete(nodes: list[dict]) -> bool:
    """Retourne True si aucun nœud n'est marqué complete=False."""
    for node in nodes:
        if not node.get("complete", True):
            return False
        if not _all_complete(node.get("children", [])):
            return False
    return True


def _slug(filename: str) -> str:
    return Path(filename).stem


# ── API publique ────────────────────────────────────────────────────────────────

def get_repertoires_dir() -> Path:
    return Path(settings.REPERTOIRES_DIR)


def list_repertoires() -> list[RepertoireMeta]:
    """
    Scanne REPERTOIRES_DIR et retourne les métadonnées de tous les JSON valides.
    Ne charge pas les arbres complets — lecture légère O(1) par fichier.
    """
    directory = get_repertoires_dir()
    if not directory.exists():
        return []

    results = []
    for path in sorted(directory.glob("*.json")):
        try:
            meta = _read_meta(path)
            if meta is not None:
                results.append(meta)
        except Exception:
            # Fichier corrompu ou format inattendu → on l'ignore silencieusement
            pass

    return results


def _read_meta(path: Path) -> Optional[RepertoireMeta]:
    """Lit uniquement les métadonnées d'un fichier JSON (pas l'arbre complet)."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    # Champs obligatoires
    required = {"opening_name", "color", "elo_range", "frequency_threshold",
                "initial_moves", "root_fen", "children"}
    if not required.issubset(data.keys()):
        return None

    children = data.get("children", [])
    node_count = _count_nodes(children)
    complete = _all_complete(children) and not data.get("pending_root_moves", [])

    # Poids — optionnels pour la rétrocompatibilité
    weights = data.get("weights", {})
    return RepertoireMeta(
        slug=_slug(path.name),
        filename=path.name,
        opening_name=data["opening_name"],
        color=data["color"],
        elo_range=data["elo_range"],
        frequency_threshold=float(data["frequency_threshold"]),
        initial_moves=data.get("initial_moves", []),
        w_winrate=float(data.get("w_winrate", weights.get("winrate", 0.5))),
        w_stockfish=float(data.get("w_stockfish", weights.get("stockfish", 0.3))),
        w_frequency=float(data.get("w_frequency", weights.get("frequency", 0.1))),
        w_consistency=float(data.get("w_consistency", weights.get("consistency", 0.1))),
        node_count=node_count,
        complete=complete,
    )


def load_tree(slug: str) -> Optional[RepertoireTree]:
    """
    Charge l'arbre complet d'un répertoire par son slug.
    Retourne None si le fichier est introuvable ou invalide.
    """
    directory = get_repertoires_dir()
    path = directory / f"{slug}.json"
    if not path.exists():
        return None

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    meta = _read_meta(path)
    if meta is None:
        return None

    return RepertoireTree(
        meta=meta,
        root_fen=data["root_fen"],
        children=data.get("children", []),
    )


def file_hash(slug: str) -> Optional[str]:
    """Hash MD5 du fichier JSON — permet au frontend de détecter un changement."""
    path = get_repertoires_dir() / f"{slug}.json"
    if not path.exists():
        return None
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
