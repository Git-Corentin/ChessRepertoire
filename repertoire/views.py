"""
views.py — Endpoints REST.

Endpoints :
  GET  /                           → page principale (shell HTML)
  GET  /api/repertoires/           → liste des répertoires
  GET  /api/tree/<slug>/?freq=     → arbre filtré
  POST /api/training/start/        → démarre une ligne
  POST /api/training/move/         → joue un coup
  POST /api/training/hint/         → révèle le coup attendu
  POST /api/training/lock/         → verrouille / déverrouille
  GET  /api/training/state/        → état courant
  POST /api/correct/fetch/         → récupère parties Chess.com et détecte erreurs
"""

import json
from functools import wraps

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_http_methods
from django.shortcuts import render

from . import scanner, filter as rep_filter, training as tr, correct as corr


# ── Helpers ─────────────────────────────────────────────────────────────────────

def json_error(message: str, status: int = 400) -> JsonResponse:
    return JsonResponse({"error": message}, status=status)


def require_json_body(f):
    @wraps(f)
    def wrapper(request, *args, **kwargs):
        try:
            body = json.loads(request.body or "{}")
        except json.JSONDecodeError:
            return json_error("Corps JSON invalide")
        return f(request, *args, body=body, **kwargs)
    return wrapper


# ── Vue principale ──────────────────────────────────────────────────────────────

@ensure_csrf_cookie
def index(request):
    return render(request, "repertoire/index.html")


# ── /api/repertoires/ ───────────────────────────────────────────────────────────

@require_http_methods(["GET"])
def api_repertoires(request):
    metas = scanner.list_repertoires()
    return JsonResponse({
        "repertoires": [
            {
                "slug": m.slug,
                "opening_name": m.opening_name,
                "color": m.color,
                "elo_range": m.elo_range,
                "frequency_threshold": m.frequency_threshold,
                "initial_moves": m.initial_moves,
                "weights": {
                    "winrate": m.w_winrate,
                    "stockfish": m.w_stockfish,
                    "frequency": m.w_frequency,
                    "consistency": m.w_consistency,
                },
                "node_count": m.node_count,
                "complete": m.complete,
            }
            for m in metas
        ]
    })


# ── /api/tree/<slug>/ ───────────────────────────────────────────────────────────

@require_http_methods(["GET"])
def api_tree(request, slug: str):
    tree_full = scanner.load_tree(slug)
    if tree_full is None:
        return json_error("Répertoire introuvable", 404)

    try:
        threshold = float(request.GET.get("freq", tree_full.meta.frequency_threshold))
    except ValueError:
        return json_error("Paramètre 'freq' invalide")
    threshold = max(0.0, min(1.0, threshold))

    filtered = rep_filter.filter_tree(tree_full.children, threshold)
    line_count = rep_filter.count_lines(filtered)

    return JsonResponse({
        "slug": slug,
        "opening_name": tree_full.meta.opening_name,
        "color": tree_full.meta.color,
        "elo_range": tree_full.meta.elo_range,
        "initial_moves": tree_full.meta.initial_moves,
        "root_fen": tree_full.root_fen,
        "frequency_threshold": threshold,
        "line_count": line_count,
        "children": filtered,
    })


# ── /api/training/start/ ────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_training_start(request, body: dict):
    slug = body.get("slug")
    if not slug:
        return json_error("'slug' obligatoire")

    tree_full = scanner.load_tree(slug)
    if tree_full is None:
        return json_error("Répertoire introuvable", 404)

    threshold = float(body.get("freq", tree_full.meta.frequency_threshold))
    threshold = max(0.0, min(1.0, threshold))

    weight_exponent = float(body.get("weight_exponent", 1.0))
    weight_exponent = max(0.1, min(5.0, weight_exponent))

    # On préserve le verrou s'il était posé en session
    existing = request.session.get("training_state", {})
    lock_fen = body.get("lock_fen", existing.get("lock_fen"))
    lock_node_path = body.get("lock_node_path", existing.get("lock_node_path", []))

    filtered = rep_filter.filter_tree(tree_full.children, threshold)

    state = tr.init_training_state(
        slug=slug,
        filtered_children=filtered,
        frequency_threshold=threshold,
        lock_fen=lock_fen or None,
        lock_node_path=lock_node_path or None,
        weight_exponent=weight_exponent,
    )

    if state is None:
        return json_error("Aucune ligne disponible avec ces paramètres", 404)

    state["root_fen"] = tree_full.root_fen
    state["initial_moves"] = tree_full.meta.initial_moves
    state["color"] = tree_full.meta.color

    request.session["training_state"] = state
    request.session.modified = True

    return JsonResponse({
        "status": "started",
        "root_fen": tree_full.root_fen,
        "initial_moves": tree_full.meta.initial_moves,
        "color": tree_full.meta.color,
        **tr.state_to_api(state),
    })


# ── /api/training/move/ ─────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_training_move(request, body: dict):
    state = request.session.get("training_state")
    if not state:
        return json_error("Aucune session active", 400)

    move_uci = (body.get("move_uci") or "").strip()
    if not move_uci:
        return json_error("'move_uci' obligatoire")

    if state.get("line_done"):
        return json_error("Ligne déjà terminée")

    state = tr.advance_state(state, move_uci)
    request.session["training_state"] = state
    request.session.modified = True

    return JsonResponse(tr.state_to_api(state))


# ── /api/training/hint/ ─────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
def api_training_hint(request):
    state = request.session.get("training_state")
    if not state:
        return json_error("Aucune session active", 400)

    idx = state.get("current_index", 0)
    revealed = state.setdefault("revealed", [])
    if idx not in revealed:
        revealed.append(idx)

    request.session["training_state"] = state
    request.session.modified = True
    return JsonResponse(tr.state_to_api(state))


# ── /api/training/lock/ ─────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_training_lock(request, body: dict):
    # On peut verrouiller sans session active (ex. depuis la vue visualisation).
    # Dans ce cas, on stocke juste le verrou pour qu'il soit utilisé au prochain start.
    state = request.session.get("training_state", {})
    state["lock_fen"] = body.get("lock_fen")
    state["lock_node_path"] = body.get("lock_node_path", [])
    request.session["training_state"] = state
    request.session.modified = True
    return JsonResponse({
        "status": "locked" if state["lock_fen"] else "unlocked",
        "lock_fen": state["lock_fen"],
        "lock_node_path": state["lock_node_path"],
    })


# ── /api/training/state/ ────────────────────────────────────────────────────────

@require_http_methods(["GET"])
def api_training_state(request):
    state = request.session.get("training_state")
    if not state:
        return JsonResponse({"active": False})
    return JsonResponse({
        "active": True,
        "repertoire_slug": state.get("repertoire_slug"),
        "color": state.get("color"),
        "lock_fen": state.get("lock_fen"),
        **tr.state_to_api(state),
    })


# ── /api/correct/fetch/ ─────────────────────────────────────────────────────────
# Récupère les parties Chess.com d'un joueur et détecte où il est sorti
# de son répertoire. C'est une opération coûteuse (appels réseau vers Chess.com,
# parsing PGN) donc on met un timeout côté client et on documente bien.

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_correct_fetch(request, body: dict):
    username = (body.get("username") or "").strip()
    if not username:
        return json_error("'username' obligatoire")

    slug = body.get("repertoire_slug") or ""
    if not slug:
        return json_error("'repertoire_slug' obligatoire")

    tree_full = scanner.load_tree(slug)
    if tree_full is None:
        return json_error("Répertoire introuvable", 404)

    try:
        months_back = int(body.get("months_back", 1))
    except (TypeError, ValueError):
        return json_error("'months_back' invalide")
    months_back = max(1, min(12, months_back))

    only_with_error = bool(body.get("only_with_error", True))

    threshold = float(body.get("freq", tree_full.meta.frequency_threshold))
    threshold = max(0.0, min(1.0, threshold))

    filtered = rep_filter.filter_tree(tree_full.children, threshold)
    user_color = tree_full.meta.color
    initial_moves = tree_full.meta.initial_moves

    try:
        analyses = corr.list_analyzed_games(
            username=username,
            months_back=months_back,
            repertoire_children=filtered,
            user_color=user_color,
            initial_moves_san=initial_moves,
            only_with_error=only_with_error,
            max_games=100,
        )
    except Exception as e:
        return json_error(f"Erreur lors de la récupération : {e}", 500)

    return JsonResponse({
        "username": username,
        "repertoire_slug": slug,
        "months_back": months_back,
        "count": len(analyses),
        "games": [corr.game_analysis_to_api(a) for a in analyses],
    })


# ── /api/correct/save-error/ ────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_correct_save_error(request, body: dict):
    """
    Sauvegarde (ou incrémente) une erreur dans la base.
    Body : { fen, expected_uci, expected_san, played_uci, played_san,
             repertoire_slug, game_id }
    """
    from .models import SavedError, normalize_fen

    fen = (body.get("fen") or "").strip()
    slug = (body.get("repertoire_slug") or "").strip()
    expected_uci = (body.get("expected_uci") or "").strip()
    expected_san = (body.get("expected_san") or "").strip()

    if not fen or not slug or not expected_uci:
        return json_error("'fen', 'repertoire_slug' et 'expected_uci' obligatoires")

    fen_norm = normalize_fen(fen)

    try:
        obj, created = SavedError.objects.get_or_create(
            repertoire_slug=slug,
            fen_normalized=fen_norm,
            defaults={
                "fen_full":      fen,
                "expected_uci":  expected_uci,
                "expected_san":  expected_san,
                "played_uci":    body.get("played_uci") or "",
                "played_san":    body.get("played_san") or "",
                "first_game_id": body.get("game_id") or "",
            },
        )
        if not created:
            # Incrémenter le compteur (même position revue)
            obj.count += 1
            obj.save(update_fields=["count", "last_seen"])
    except Exception as e:
        return json_error(f"Erreur base de données : {e}", 500)

    return JsonResponse({
        "status": "created" if created else "incremented",
        "count": obj.count,
        "id": obj.id,
    })


# ── /api/correct/my-errors/ ─────────────────────────────────────────────────────

@require_http_methods(["GET"])
def api_correct_my_errors(request):
    """Liste les erreurs sauvegardées pour un répertoire, triées par count DESC."""
    from .models import SavedError

    slug = request.GET.get("repertoire_slug", "").strip()
    if not slug:
        return json_error("'repertoire_slug' obligatoire")

    errors = SavedError.objects.filter(repertoire_slug=slug).order_by("-count", "-last_seen")[:100]
    return JsonResponse({
        "count": errors.count() if hasattr(errors, 'count') else len(errors),
        "errors": [
            {
                "id": e.id,
                "fen": e.fen_full,
                "fen_normalized": e.fen_normalized,
                "expected_uci": e.expected_uci,
                "expected_san": e.expected_san,
                "played_uci":   e.played_uci,
                "played_san":   e.played_san,
                "count":        e.count,
                "last_seen":    e.last_seen.isoformat() if e.last_seen else None,
            }
            for e in errors
        ],
    })


# ── /api/correct/delete-error/ ─────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_correct_delete_error(request, body: dict):
    """Supprime une erreur sauvegardée (quand l'utilisateur estime l'avoir maîtrisée)."""
    from .models import SavedError
    err_id = body.get("id")
    if not err_id:
        return json_error("'id' obligatoire")
    deleted, _ = SavedError.objects.filter(id=err_id).delete()
    return JsonResponse({"deleted": deleted})


# ── /api/training/start-from-errors/ ────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@require_json_body
def api_training_start_from_errors(request, body: dict):
    """
    Démarre une session d'entraînement sur une erreur sauvegardée.
    Choisit une erreur au hasard (pondérée par count) parmi celles du répertoire,
    puis démarre normalement une session training avec cette position en verrou.
    """
    import random as _random
    from .models import SavedError

    slug = body.get("slug") or body.get("repertoire_slug") or ""
    if not slug:
        return json_error("'slug' obligatoire")

    tree_full = scanner.load_tree(slug)
    if tree_full is None:
        return json_error("Répertoire introuvable", 404)

    errors = list(SavedError.objects.filter(repertoire_slug=slug))
    if not errors:
        return json_error("Aucune erreur sauvegardée pour ce répertoire", 404)

    # Tirage pondéré par count : plus l'erreur est fréquente, plus on la revoit
    weights = [e.count for e in errors]
    total = sum(weights)
    r = _random.uniform(0, total)
    cumul = 0.0
    picked = errors[-1]
    for e, w in zip(errors, weights):
        cumul += w
        if r <= cumul:
            picked = e
            break

    threshold = float(body.get("freq", tree_full.meta.frequency_threshold))
    threshold = max(0.0, min(1.0, threshold))
    weight_exponent = float(body.get("weight_exponent", 1.0))
    weight_exponent = max(0.0, min(5.0, weight_exponent))

    filtered = rep_filter.filter_tree(tree_full.children, threshold)

    state = tr.init_training_state(
        slug=slug,
        filtered_children=filtered,
        frequency_threshold=threshold,
        lock_fen=picked.fen_full,
        lock_node_path=None,
        weight_exponent=weight_exponent,
    )

    if state is None:
        return json_error("Impossible de démarrer : la position verrouillée n'est pas dans le répertoire filtré", 404)

    state["root_fen"] = tree_full.root_fen
    state["initial_moves"] = tree_full.meta.initial_moves
    state["color"] = tree_full.meta.color

    request.session["training_state"] = state
    request.session.modified = True

    return JsonResponse({
        "status": "started",
        "root_fen": tree_full.root_fen,
        "initial_moves": tree_full.meta.initial_moves,
        "color": tree_full.meta.color,
        "error_info": {
            "id": picked.id,
            "count": picked.count,
            "expected_san": picked.expected_san,
            "played_san":   picked.played_san,
        },
        **tr.state_to_api(state),
    })