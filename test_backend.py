"""Tests standalone — sans Django ni python-chess."""
import sys, json, random, types
from pathlib import Path

# Stub django.conf
django_stub = types.ModuleType("django")
conf_stub   = types.ModuleType("django.conf")
class _Settings:
    REPERTOIRES_DIR = Path(__file__).parent / "repertoires_data"
conf_stub.settings = _Settings()
django_stub.conf = conf_stub
sys.modules["django"]      = django_stub
sys.modules["django.conf"] = conf_stub

sys.path.insert(0, str(Path(__file__).parent))
from repertoire.filter   import filter_tree, count_lines, collect_lines, line_cumulative_weight
from repertoire.training import (
    select_line, init_training_state, advance_state, state_to_api,
)
from repertoire.scanner  import _read_meta, _count_nodes, load_tree

TREE = json.load(open(Path(__file__).parent / "repertoires_data" / "gambit_du_roi_test.json"))
CHILDREN = TREE["children"]

# ── FILTER ─────────────────────────────────────────────────────────────────────

def test_filter_basic():
    assert len(filter_tree(CHILDREN, 0.0)) == 2
    assert len(filter_tree(CHILDREN, 0.5)) == 1
    print("  ✓ filter: basique")

def test_filter_deep():
    result = filter_tree(CHILDREN, 0.2)
    nf3_children = result[0]["children"][0]["children"]
    sans = [n["move_san"] for n in nf3_children]
    assert "Nf6" in sans and "d5" not in sans
    print("  ✓ filter: élagage profond")

def test_count_collect_lines():
    filtered = filter_tree(CHILDREN, 0.001)
    assert count_lines(filtered) == 4
    assert len(collect_lines(filtered)) == 4
    print("  ✓ filter: count + collect lines")

# ── TRAINING ───────────────────────────────────────────────────────────────────

def test_init_state():
    filtered = filter_tree(CHILDREN, 0.001)
    state = init_training_state("test", filtered, 0.001)
    assert state is not None
    # current_index doit pointer sur un coup à nous
    line = state["current_line"]
    idx = state["current_index"]
    assert line[idx]["is_our_move"], f"idx={idx} pas notre coup"
    print(f"  ✓ training: init state — ligne de {len(line)} coup(s), idx={idx}")

def test_advance_correct():
    filtered = filter_tree(CHILDREN, 0.001)
    random.seed(0)
    state = init_training_state("test", filtered, 0.001)
    idx = state["current_index"]
    expected = state["current_line"][idx]["move_uci"]
    new_state = advance_state(state, expected)
    assert new_state["errors"] == []
    # Soit ligne done, soit avancé
    if not new_state["line_done"]:
        assert new_state["current_index"] > idx
        assert new_state["current_line"][new_state["current_index"]]["is_our_move"]
    print(f"  ✓ training: coup correct → avance ou termine")

def test_advance_wrong():
    filtered = filter_tree(CHILDREN, 0.001)
    random.seed(0)
    state = init_training_state("test", filtered, 0.001)
    idx = state["current_index"]
    new_state = advance_state(state, "a2a4")
    assert idx in new_state["errors"]
    assert new_state["current_index"] == idx
    assert not new_state["line_done"]
    print("  ✓ training: coup incorrect → erreur enregistrée, idx inchangé")

def test_state_to_api_full_line():
    """L'API expose la ligne ENTIÈRE avec move_uci et fen_after."""
    filtered = filter_tree(CHILDREN, 0.001)
    random.seed(0)
    state = init_training_state("test", filtered, 0.001)
    api = state_to_api(state)
    assert "line" in api
    assert len(api["line"]) == len(state["current_line"])
    for n in api["line"]:
        assert "move_uci" in n and "fen_after" in n and "is_our_move" in n
    print(f"  ✓ training: state_to_api expose ligne complète ({len(api['line'])} coups)")

def test_state_to_api_hides_expected():
    filtered = filter_tree(CHILDREN, 0.001)
    state = init_training_state("test", filtered, 0.001)
    api = state_to_api(state)
    assert api["expected_move"] is None
    print("  ✓ training: expected_move masqué au départ")

def test_state_to_api_reveals_on_error():
    filtered = filter_tree(CHILDREN, 0.001)
    random.seed(0)
    state = init_training_state("test", filtered, 0.001)
    state = advance_state(state, "a2a4")
    api = state_to_api(state)
    assert api["expected_move"] is not None
    print(f"  ✓ training: expected_move révélé après erreur ({api['expected_move']['san']})")

def test_full_completion():
    filtered = filter_tree(CHILDREN, 0.001)
    random.seed(1)
    state = init_training_state("test", filtered, 0.001)
    steps = 0
    while not state["line_done"] and steps < 30:
        idx = state["current_index"]
        expected = state["current_line"][idx]["move_uci"]
        state = advance_state(state, expected)
        steps += 1
    assert state["line_done"]
    assert state["errors"] == []
    print(f"  ✓ training: ligne complétée en {steps} coup(s)")

def test_weighted_selection():
    """Vérifie le tirage pondéré."""
    random.seed(42)
    filtered = filter_tree(CHILDREN, 0.001)
    counts = {"exf4": 0, "e4": 0}
    for _ in range(1000):
        line, _ = select_line(filtered)
        first_san = line[0]["move_san"]
        counts[first_san] = counts.get(first_san, 0) + 1
    ratio = counts["exf4"] / 1000
    assert 0.78 < ratio < 0.95, f"ratio={ratio}"
    print(f"  ✓ training: sélection pondérée — exf4={counts['exf4']}/1000")

def test_lock_with_path():
    filtered = filter_tree(CHILDREN, 0.001)
    # path=[0] = enfants de exf4
    result = select_line(filtered, lock_node_path=[0])
    assert result is not None
    line, prefix_len = result
    assert prefix_len == 1, f"prefix_len attendu 1, obtenu {prefix_len}"
    assert line[0]["move_san"] == "exf4"
    print(f"  ✓ training: verrou avec préfixe — ligne démarre par {line[0]['move_san']}, prefix_len={prefix_len}")

def test_lock_by_fen():
    """Verrouiller par FEN doit retrouver le path et inclure le préfixe."""
    from repertoire.training import find_node_path_by_fen
    filtered = filter_tree(CHILDREN, 0.001)
    target_fen = filtered[0]["children"][0]["fen_after"]  # après Nf3
    path = find_node_path_by_fen(filtered, target_fen)
    assert path == [0, 0], f"path attendu [0,0], obtenu {path}"

    line, prefix_len = select_line(filtered, lock_fen=target_fen)
    assert prefix_len == 2
    sans = [n["move_san"] for n in line]
    assert sans[:2] == ["exf4", "Nf3"], f"prefix incorrect : {sans}"
    print(f"  ✓ training: verrou par FEN — ligne {sans}, prefix_len={prefix_len}")

def test_init_state_with_lock_skips_prefix():
    """init_training_state avec lock doit placer current_index après le préfixe."""
    filtered = filter_tree(CHILDREN, 0.001)
    target_fen = filtered[0]["children"][0]["fen_after"]  # après Nf3
    random.seed(999)
    state = init_training_state("test", filtered, 0.001, lock_fen=target_fen)
    assert state is not None
    assert state["prefix_len"] == 2, f"prefix_len = {state['prefix_len']}"
    # current_index doit pointer APRÈS le préfixe, sur un coup à nous
    assert state["current_index"] >= state["prefix_len"]
    node = state["current_line"][state["current_index"]]
    assert node["is_our_move"]
    sans = [n["move_san"] for n in state["current_line"]]
    print(f"  ✓ training: verrou saute le préfixe — ligne {sans}, current_index={state['current_index']}")

# ── SCANNER ────────────────────────────────────────────────────────────────────

def test_scanner():
    p = Path(__file__).parent / "repertoires_data" / "gambit_du_roi_test.json"
    meta = _read_meta(p)
    assert meta is not None
    assert meta.opening_name == "Gambit du Roi (test)"
    assert _count_nodes(CHILDREN) == 10
    tree = load_tree("gambit_du_roi_test")
    assert tree is not None
    print(f"  ✓ scanner: tout fonctionne")

def test_castling_uci_equivalence():
    """advance_state doit accepter les deux conventions UCI du roque."""
    from repertoire.training import advance_state
    # Ligne fictive avec un roque attendu (e1g1, convention standard)
    state = {
        "current_line": [
            {"move_uci": "e2e4", "move_san": "e4", "fen_after": "", "is_our_move": True},
            {"move_uci": "e1g1", "move_san": "O-O", "fen_after": "", "is_our_move": True},
        ],
        "current_index": 1,
        "errors": [],
        "revealed": [],
        "line_done": False,
    }
    # Jouer e1h1 (Chess960) doit être accepté comme équivalent
    import copy
    s1 = copy.deepcopy(state)
    s1 = advance_state(s1, "e1h1")
    assert s1["errors"] == [], "e1h1 doit être accepté comme équivalent de e1g1"
    assert s1["line_done"] is True
    # Jouer e1g1 (standard) doit marcher directement
    s2 = copy.deepcopy(state)
    s2 = advance_state(s2, "e1g1")
    assert s2["errors"] == []
    # Jouer un mauvais coup doit être rejeté
    s3 = copy.deepcopy(state)
    s3 = advance_state(s3, "e1f1")
    assert s3["errors"] == [1]
    print("  ✓ training: roque accepté en UCI standard ET Chess960")

# ── Runner ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_filter_basic, test_filter_deep, test_count_collect_lines,
        test_init_state, test_advance_correct, test_advance_wrong,
        test_state_to_api_full_line, test_state_to_api_hides_expected,
        test_state_to_api_reveals_on_error, test_full_completion,
        test_weighted_selection, test_lock_with_path, test_lock_by_fen,
        test_init_state_with_lock_skips_prefix,
        test_castling_uci_equivalence,
        test_scanner,
    ]
    ok = 0
    for t in tests:
        try:
            t()
            ok += 1
        except Exception as e:
            print(f"  ✗ {t.__name__}: {e}")
    print(f"\n  {ok}/{len(tests)} tests passés", "✓" if ok == len(tests) else "✗")
    sys.exit(0 if ok == len(tests) else 1)