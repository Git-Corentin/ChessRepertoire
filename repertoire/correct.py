"""
correct.py
──────────
Module pour la vue "Se corriger" : récupérer les parties d'un joueur
sur Chess.com, les filtrer selon le répertoire courant, et détecter
où le joueur a quitté son répertoire.

Architecture
────────────
  fetch_chess_com_games(username, months_back)
    → appelle l'API Chess.com, parse les PGN, filtre par couleur
    → retourne une liste de Game (dataclass)

  analyze_game_against_repertoire(game, repertoire_children, user_color)
    → parcourt les coups du joueur un à un dans l'arbre du répertoire
    → retourne un GameAnalysis avec error_at, expected_moves, played_uci

  list_faulty_games(username, months_back, repertoire_children, user_color)
    → combine les deux, retourne les parties avec erreur détectée

L'API Chess.com exige un User-Agent avec une info de contact (email).
Sans ça : 403 Forbidden. On utilise donc un User-Agent clairement identifié.
Rate limit : pas plus de ~3 requêtes simultanées, on fait du séquentiel.
"""

from __future__ import annotations

import io
import re
import time
import urllib.request
import urllib.error
import json as _json
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Optional

import chess
import chess.pgn


# Chess.com exige un User-Agent contenant une info de contact (email) — sinon 403.
# On lit la config depuis settings.py, avec un fallback si pas configuré.
def _get_user_agent() -> str:
    try:
        from django.conf import settings
        ua = getattr(settings, "CHESS_COM_USER_AGENT", None)
        if ua:
            return ua
    except Exception:
        pass
    return "ChessRepertoireApp/1.0 (contact: configure-in-settings)"

CHESS_COM_TIMEOUT = 15  # secondes


# ── Types de données ────────────────────────────────────────────────────────────

@dataclass
class Game:
    """Une partie récupérée depuis Chess.com."""
    game_id: str            # URL complète de la partie (identifiant unique)
    opponent: str           # pseudo de l'adversaire
    user_color: str         # "white" ou "black"
    result: str             # "1-0", "0-1", "1/2-1/2"
    user_result: str        # "win", "loss", "draw"
    time_control: str       # e.g. "600", "180+2"
    time_class: str         # "rapid", "blitz", "bullet", "daily"
    played_at: str          # ISO date
    eco: Optional[str]      # code ECO si disponible
    moves_uci: list[str]    # tous les coups en UCI (joueur + adversaire)
    moves_san: list[str]    # tous les coups en SAN
    user_move_indices: list[int]  # indices dans moves_uci/san des coups du joueur


@dataclass
class GameAnalysis:
    """Résultat de l'analyse d'une partie vs un répertoire."""
    game: Game
    in_repertoire: bool       # la partie est-elle restée (au moins au début) dans le répertoire ?
    error_at: Optional[int]   # index dans game.moves_uci du coup fautif du joueur (None si pas d'erreur)
    played_uci: Optional[str] # ce que le joueur a effectivement joué à cet index
    played_san: Optional[str]
    expected_moves: list[dict]  # les coups du répertoire à cette position [{"uci":…, "san":…, "frequency":…}, …]
    depth_reached: int        # combien de coups du joueur sont restés dans le répertoire avant l'erreur
    line_before_error: list[dict]  # coups joués suivis, pour affichage au début


# ── Chess.com API ───────────────────────────────────────────────────────────────

def _http_get(url: str) -> Optional[bytes]:
    """GET avec User-Agent Chess.com-compliant. Retourne None en cas d'erreur."""
    req = urllib.request.Request(url, headers={"User-Agent": _get_user_agent()})
    try:
        with urllib.request.urlopen(req, timeout=CHESS_COM_TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        return None
    except (urllib.error.URLError, TimeoutError):
        return None


def _get_archive_urls(username: str) -> list[str]:
    """Liste les URLs d'archives mensuelles du joueur."""
    url = f"https://api.chess.com/pub/player/{username}/games/archives"
    raw = _http_get(url)
    if raw is None:
        return []
    try:
        data = _json.loads(raw)
        return list(data.get("archives", []))
    except _json.JSONDecodeError:
        return []


def _get_month_games(archive_url: str) -> list[dict]:
    """Récupère les parties d'un mois. Retourne la liste brute de l'API Chess.com."""
    raw = _http_get(archive_url)
    if raw is None:
        return []
    try:
        data = _json.loads(raw)
        return list(data.get("games", []))
    except _json.JSONDecodeError:
        return []


def _parse_pgn_to_game(pgn_text: str, api_data: dict, requested_username: str) -> Optional[Game]:
    """Parse un PGN en une Game. Retourne None si échec."""
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return None
    if game is None:
        return None

    headers = game.headers
    white = headers.get("White", "").lower()
    black = headers.get("Black", "").lower()
    username_lc = requested_username.lower()

    if username_lc == white:
        user_color = "white"
    elif username_lc == black:
        user_color = "black"
    else:
        return None  # pas la partie du joueur demandé

    result = headers.get("Result", "*")
    if result == "1-0":
        user_result = "win" if user_color == "white" else "loss"
    elif result == "0-1":
        user_result = "loss" if user_color == "white" else "win"
    elif result == "1/2-1/2":
        user_result = "draw"
    else:
        user_result = "unknown"

    moves_uci = []
    moves_san = []
    user_move_indices = []
    board = game.board()
    for i, move in enumerate(game.mainline_moves()):
        try:
            san = board.san(move)
        except Exception:
            break  # coup invalide, arrêt du parsing
        moves_san.append(san)
        moves_uci.append(move.uci())
        # Est-ce un coup du joueur ?
        if (user_color == "white" and i % 2 == 0) or (user_color == "black" and i % 2 == 1):
            user_move_indices.append(i)
        board.push(move)

    if not moves_uci:
        return None  # partie vide

    return Game(
        game_id=api_data.get("url", headers.get("Site", "")),
        opponent=black if user_color == "white" else white,
        user_color=user_color,
        result=result,
        user_result=user_result,
        time_control=api_data.get("time_control", headers.get("TimeControl", "")),
        time_class=api_data.get("time_class", ""),
        played_at=headers.get("UTCDate", "") + "T" + headers.get("UTCTime", ""),
        eco=headers.get("ECO"),
        moves_uci=moves_uci,
        moves_san=moves_san,
        user_move_indices=user_move_indices,
    )


def fetch_chess_com_games(
    username: str,
    months_back: int = 1,
    user_color: Optional[str] = None,
    max_games: int = 100,
) -> list[Game]:
    """
    Récupère les parties Chess.com d'un joueur sur les N derniers mois.

    - months_back: nombre de mois à parcourir (à partir du plus récent)
    - user_color: si fourni ("white" ou "black"), ne garde que les parties
                  où le joueur avait cette couleur
    - max_games: plafond de sécurité pour éviter de charger des milliers de parties
    """
    archives = _get_archive_urls(username)
    if not archives:
        return []

    # Les archives sont triées chronologiquement ; on prend les N dernières
    archives_recent = archives[-months_back:] if months_back > 0 else archives

    games_out: list[Game] = []
    for archive_url in reversed(archives_recent):  # du plus récent au plus ancien
        if len(games_out) >= max_games:
            break
        raw_games = _get_month_games(archive_url)
        # rate limit : 1 requête/seconde entre les mois
        time.sleep(1.0)

        # On parcourt les parties du plus récent au plus ancien dans le mois
        for api_data in reversed(raw_games):
            if len(games_out) >= max_games:
                break
            pgn_text = api_data.get("pgn", "")
            if not pgn_text:
                continue
            game = _parse_pgn_to_game(pgn_text, api_data, username)
            if game is None:
                continue
            if user_color and game.user_color != user_color:
                continue
            games_out.append(game)

    return games_out


# ── Analyse vs répertoire ───────────────────────────────────────────────────────

def analyze_game_against_repertoire(
    game: Game,
    repertoire_children: list[dict],
    user_color: str,
    initial_moves_san: Optional[list[str]] = None,
) -> GameAnalysis:
    """
    Parcourt les coups de la partie et vérifie qu'ils sont dans le répertoire.
    S'arrête au premier coup qui diverge.

    Paramètres
    ──────────
    initial_moves_san : les coups du répertoire qui précèdent la racine de l'arbre
                        (e.g. ["e4", "e5", "f4"] pour le Gambit du Roi).
                        Si fournis, on vérifie que les N premiers coups de la partie
                        correspondent — sinon la partie n'utilise pas ce répertoire
                        et on retourne depth_reached=0.

    Logique de parcours (après les initial_moves) :
      - Si le coup joué correspond à un enfant → on descend
      - Sinon :
         - Si c'est un coup du JOUEUR → erreur du joueur (error_at = i)
         - Sinon → l'adversaire est sorti du répertoire, pas d'erreur nôtre
    """
    # ── Phase 1 : vérifier les coups initiaux du répertoire ──────────────────
    skip = 0
    if initial_moves_san:
        skip = len(initial_moves_san)
        if len(game.moves_san) < skip:
            # Partie trop courte pour couvrir les initial_moves
            return GameAnalysis(
                game=game, in_repertoire=False,
                error_at=None, played_uci=None, played_san=None,
                expected_moves=[], depth_reached=0, line_before_error=[],
            )
        for i, expected_san in enumerate(initial_moves_san):
            played_san = game.moves_san[i]
            if _san_equiv(played_san, expected_san):
                continue
            # Un des coups initiaux ne correspond pas :
            # si c'est un coup DE L'ADVERSAIRE et que le joueur a déjà suivi les
            # siens correctement jusqu'ici, la partie a juste quitté le répertoire
            # — pas une erreur du joueur. Sinon, c'est une vraie divergence.
            is_user_move = (user_color == "white" and i % 2 == 0) or (user_color == "black" and i % 2 == 1)
            if is_user_move:
                # Le joueur a choisi une autre ouverture : la partie n'utilise
                # simplement pas ce répertoire — on retourne depth_reached=0.
                return GameAnalysis(
                    game=game, in_repertoire=False,
                    error_at=None, played_uci=None, played_san=None,
                    expected_moves=[], depth_reached=0, line_before_error=[],
                )
            # Adversaire : partie hors répertoire aussi, mais pas d'erreur joueur
            return GameAnalysis(
                game=game, in_repertoire=False,
                error_at=None, played_uci=None, played_san=None,
                expected_moves=[], depth_reached=0, line_before_error=[],
            )

    # ── Phase 2 : parcourir l'arbre à partir du skip ────────────────────────
    current_children = repertoire_children
    depth = 0
    line_before: list[dict] = []

    for offset, i in enumerate(range(skip, len(game.moves_uci))):
        uci = game.moves_uci[i]
        is_user_move = (user_color == "white" and i % 2 == 0) or (user_color == "black" and i % 2 == 1)

        matched = next((c for c in current_children if _uci_equiv(c.get("move_uci", ""), uci)), None)

        if matched is None:
            if is_user_move:
                expected = [
                    {
                        "uci": c.get("move_uci", ""),
                        "san": c.get("move_san", ""),
                        "frequency": c.get("frequency", 0.0),
                        "cumulative_frequency": c.get("cumulative_frequency", 0.0),
                    }
                    for c in current_children
                ]
                return GameAnalysis(
                    game=game, in_repertoire=True, error_at=i,
                    played_uci=uci,
                    played_san=game.moves_san[i] if i < len(game.moves_san) else "",
                    expected_moves=expected, depth_reached=depth,
                    line_before_error=line_before,
                )
            # Adversaire hors répertoire
            return GameAnalysis(
                game=game, in_repertoire=True, error_at=None,
                played_uci=None, played_san=None, expected_moves=[],
                depth_reached=depth, line_before_error=line_before,
            )

        line_before.append({
            "uci": matched["move_uci"],
            "san": matched["move_san"],
            "is_user_move": is_user_move,
        })
        current_children = matched.get("children", [])
        depth += 1

        if not current_children:
            return GameAnalysis(
                game=game, in_repertoire=True, error_at=None,
                played_uci=None, played_san=None, expected_moves=[],
                depth_reached=depth, line_before_error=line_before,
            )

    return GameAnalysis(
        game=game, in_repertoire=True, error_at=None,
        played_uci=None, played_san=None, expected_moves=[],
        depth_reached=depth, line_before_error=line_before,
    )


def _san_equiv(a: str, b: str) -> bool:
    """Compare 2 SAN en normalisant (trim, lowercase des symboles d'annotation)."""
    def norm(s: str) -> str:
        return s.strip().replace("+", "").replace("#", "").replace("!", "").replace("?", "")
    return norm(a) == norm(b)


# Équivalences UCI pour le roque (standard vs Chess960) — dupliqué depuis training.py
# pour éviter un import circulaire. À consolider dans un module commun si besoin.
_CASTLING_EQUIV = {
    "e1g1": "e1h1", "e1h1": "e1g1",
    "e1c1": "e1a1", "e1a1": "e1c1",
    "e8g8": "e8h8", "e8h8": "e8g8",
    "e8c8": "e8a8", "e8a8": "e8c8",
}


def _uci_equiv(a: str, b: str) -> bool:
    """Compare 2 UCI en acceptant les 2 conventions de roque."""
    if a == b:
        return True
    return _CASTLING_EQUIV.get(a) == b


# ── Point d'entrée haut niveau ─────────────────────────────────────────────────

def list_analyzed_games(
    username: str,
    months_back: int,
    repertoire_children: list[dict],
    user_color: str,
    initial_moves_san: Optional[list[str]] = None,
    only_with_error: bool = True,
    max_games: int = 100,
) -> list[GameAnalysis]:
    """
    Récupère les parties Chess.com, les analyse, et retourne la liste filtrée.
      - initial_moves_san : coups du répertoire précédant la racine de l'arbre
      - only_with_error=True : ne garde que les parties avec une vraie erreur du joueur
      - only_with_error=False : garde toutes les parties qui ont touché le répertoire
    """
    games = fetch_chess_com_games(username, months_back=months_back, user_color=user_color, max_games=max_games)
    analyses = []
    for g in games:
        a = analyze_game_against_repertoire(g, repertoire_children, user_color, initial_moves_san)
        if a.depth_reached == 0:
            continue
        if only_with_error and a.error_at is None:
            continue
        analyses.append(a)
    return analyses


# ── Sérialisation pour API ──────────────────────────────────────────────────────

def game_analysis_to_api(a: GameAnalysis) -> dict:
    """Format JSON-friendly d'une GameAnalysis."""
    g = a.game
    return {
        "game_id":      g.game_id,
        "opponent":     g.opponent,
        "user_color":   g.user_color,
        "result":       g.result,
        "user_result":  g.user_result,
        "time_class":   g.time_class,
        "time_control": g.time_control,
        "played_at":    g.played_at,
        "eco":          g.eco,
        "moves_uci":    g.moves_uci,
        "moves_san":    g.moves_san,
        "user_move_indices": g.user_move_indices,
        "error_at":     a.error_at,
        "played_uci":   a.played_uci,
        "played_san":   a.played_san,
        "expected_moves": a.expected_moves,
        "depth_reached":  a.depth_reached,
    }