"""Tests pour correct.py — utilisent des parties simulées (pas d'accès réseau)."""
import sys, types
from pathlib import Path

# Stubs
for mod in ["chess", "chess.pgn"]:
    sys.modules[mod] = types.ModuleType(mod)

django_stub = types.ModuleType("django")
conf_stub = types.ModuleType("django.conf")
class _S: REPERTOIRES_DIR = Path(__file__).parent / "repertoires_data"
conf_stub.settings = _S()
django_stub.conf = conf_stub
sys.modules["django"] = django_stub
sys.modules["django.conf"] = conf_stub

sys.path.insert(0, str(Path(__file__).parent))

import json
from repertoire.correct import (
    Game, GameAnalysis, analyze_game_against_repertoire,
    _uci_equiv, _san_equiv, game_analysis_to_api,
)
from repertoire.filter import filter_tree

TREE = json.load(open(Path(__file__).parent / "repertoires_data" / "gambit_du_roi_test.json"))
CHILDREN = filter_tree(TREE["children"], 0.001)
INITIAL = TREE.get("initial_moves", [])
# Attendu : ["e4", "e5", "f4"]

# ── Tests ──────────────────────────────────────────────────────────────────────

def test_initial_moves_count():
    assert INITIAL == ["e4", "e5", "f4"], f"initial_moves={INITIAL}"
    print(f"  ✓ setup: initial_moves = {INITIAL}")

def test_partie_dans_repertoire():
    """1.e4 e5 2.f4 exf4 3.Nf3 d5 4.exd5 — doit être entièrement dans le répertoire."""
    game = Game(
        game_id="t1", opponent="alice", user_color="white",
        result="1-0", user_result="win", time_control="600", time_class="rapid",
        played_at="2024-01-01T12:00:00", eco=None,
        moves_uci=["e2e4", "e7e5", "f2f4", "e5f4", "g1f3", "d7d5", "e4d5"],
        moves_san=["e4", "e5", "f4", "exf4", "Nf3", "d5", "exd5"],
        user_move_indices=[0, 2, 4, 6],
    )
    a = analyze_game_against_repertoire(game, CHILDREN, "white", INITIAL)
    assert a.error_at is None, f"pas d'erreur attendue, obtenu error_at={a.error_at}"
    assert a.depth_reached >= 3, f"depth_reached={a.depth_reached}"
    print(f"  ✓ partie entièrement dans le répertoire (depth={a.depth_reached})")

def test_erreur_joueur():
    """Après exf4, le joueur joue Qh5+ (hors répertoire) au lieu de Nf3."""
    game = Game(
        game_id="t2", opponent="bob", user_color="white",
        result="0-1", user_result="loss", time_control="600", time_class="rapid",
        played_at="2024-01-02T12:00:00", eco=None,
        moves_uci=["e2e4", "e7e5", "f2f4", "e5f4", "d1h5"],
        moves_san=["e4", "e5", "f4", "exf4", "Qh5+"],
        user_move_indices=[0, 2, 4],
    )
    a = analyze_game_against_repertoire(game, CHILDREN, "white", INITIAL)
    assert a.error_at == 4, f"erreur attendue à i=4, obtenu {a.error_at}"
    assert a.played_uci == "d1h5"
    assert a.played_san == "Qh5+"
    expected_ucis = [m["uci"] for m in a.expected_moves]
    assert "g1f3" in expected_ucis
    print(f"  ✓ erreur joueur détectée à i={a.error_at}, attendu inclut Nf3")

def test_mauvaise_ouverture():
    """Le joueur joue 1.d4 — n'utilise pas ce répertoire."""
    game = Game(
        game_id="t3", opponent="carol", user_color="white",
        result="1-0", user_result="win", time_control="600", time_class="rapid",
        played_at="2024-01-03T12:00:00", eco=None,
        moves_uci=["d2d4", "d7d5"],
        moves_san=["d4", "d5"],
        user_move_indices=[0],
    )
    a = analyze_game_against_repertoire(game, CHILDREN, "white", INITIAL)
    assert a.error_at is None
    assert a.depth_reached == 0  # n'a pas atteint l'arbre du répertoire
    print(f"  ✓ mauvaise ouverture : exclue (depth_reached=0)")

def test_adversaire_sort_dans_initial():
    """Le joueur joue 1.e4 mais l'adversaire répond 1...c5 (Sicilienne, pas dans initial)."""
    game = Game(
        game_id="t4", opponent="dave", user_color="white",
        result="1-0", user_result="win", time_control="600", time_class="rapid",
        played_at="2024-01-04T12:00:00", eco=None,
        moves_uci=["e2e4", "c7c5", "g1f3"],
        moves_san=["e4", "c5", "Nf3"],
        user_move_indices=[0, 2],
    )
    a = analyze_game_against_repertoire(game, CHILDREN, "white", INITIAL)
    # L'adversaire dévie dans les initial_moves → partie hors répertoire
    assert a.depth_reached == 0
    print(f"  ✓ adversaire dévie dans initial_moves : exclue")

def test_partie_trop_courte():
    """Partie d'1 coup, trop courte pour les initial_moves."""
    game = Game(
        game_id="t5", opponent="eve", user_color="white",
        result="0-1", user_result="loss", time_control="60", time_class="bullet",
        played_at="2024-01-05T12:00:00", eco=None,
        moves_uci=["e2e4"],
        moves_san=["e4"],
        user_move_indices=[0],
    )
    a = analyze_game_against_repertoire(game, CHILDREN, "white", INITIAL)
    assert a.depth_reached == 0
    print(f"  ✓ partie trop courte : exclue")

def test_uci_equiv():
    assert _uci_equiv("e2e4", "e2e4")
    assert _uci_equiv("e1g1", "e1h1")
    assert _uci_equiv("e8c8", "e8a8")
    assert not _uci_equiv("e2e4", "e2e3")
    print("  ✓ _uci_equiv : roque standard ↔ Chess960")

def test_san_equiv():
    assert _san_equiv("Nf3", "Nf3")
    assert _san_equiv("Qh5+", "Qh5")
    assert _san_equiv("Ra1#", "Ra1")
    assert _san_equiv("e4!", "e4")
    assert not _san_equiv("Nf3", "Nc3")
    print("  ✓ _san_equiv : normalisation annotations")

def test_api_serialization():
    game = Game(
        game_id="t6", opponent="fred", user_color="black",
        result="1-0", user_result="loss", time_control="600", time_class="rapid",
        played_at="2024-01-06T12:00:00", eco="B00",
        moves_uci=["e2e4", "c7c5"],
        moves_san=["e4", "c5"],
        user_move_indices=[1],
    )
    a = GameAnalysis(
        game=game, in_repertoire=True, error_at=None,
        played_uci=None, played_san=None, expected_moves=[],
        depth_reached=2, line_before_error=[],
    )
    api = game_analysis_to_api(a)
    assert api["game_id"] == "t6"
    assert api["user_color"] == "black"
    assert api["error_at"] is None
    assert len(api["moves_uci"]) == 2
    print("  ✓ sérialisation API")


if __name__ == "__main__":
    tests = [
        test_initial_moves_count,
        test_partie_dans_repertoire,
        test_erreur_joueur,
        test_mauvaise_ouverture,
        test_adversaire_sort_dans_initial,
        test_partie_trop_courte,
        test_uci_equiv,
        test_san_equiv,
        test_api_serialization,
    ]
    ok = 0
    for t in tests:
        try:
            t()
            ok += 1
        except Exception as e:
            print(f"  ✗ {t.__name__}: {e}")
    print(f"\n  {ok}/{len(tests)} tests correct.py passés", "✓" if ok == len(tests) else "✗")
    sys.exit(0 if ok == len(tests) else 1)