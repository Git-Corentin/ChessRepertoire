"""
models.py — Modèles Django.

SavedError stocke les positions où le joueur a commis une erreur par rapport
à son répertoire, pour permettre un entraînement ciblé sur ses points faibles.

Une erreur est identifiée par (repertoire_slug, fen_normalized) :
  - repertoire_slug : pour ne mélanger les erreurs entre répertoires
  - fen_normalized  : la position JUSTE AVANT le coup fautif, sans compteurs

À chaque nouvelle occurrence de la même erreur (même FEN dans le même
répertoire), on incrémente `count` et on met à jour `last_seen`.
"""

from django.db import models


class SavedError(models.Model):
    """Une position où l'utilisateur a commis une erreur par rapport à son répertoire."""

    repertoire_slug = models.CharField(max_length=200, db_index=True)
    # FEN normalisé (4 premiers champs, sans compteurs) — clé de déduplication
    fen_normalized  = models.CharField(max_length=100)
    # FEN complet (pour affichage et passage au backend training)
    fen_full        = models.CharField(max_length=100)

    expected_uci = models.CharField(max_length=10)
    expected_san = models.CharField(max_length=20)
    played_uci   = models.CharField(max_length=10, blank=True)
    played_san   = models.CharField(max_length=20, blank=True)

    # Métadonnées
    count      = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen  = models.DateTimeField(auto_now=True)
    # Un ID de partie (URL Chess.com) pour tracer la 1ère occurrence — optionnel
    first_game_id = models.CharField(max_length=300, blank=True)

    class Meta:
        unique_together = ("repertoire_slug", "fen_normalized")
        ordering        = ["-count", "-last_seen"]
        indexes = [
            models.Index(fields=["repertoire_slug", "-count"]),
        ]

    def __str__(self) -> str:
        return f"{self.repertoire_slug}: {self.expected_san} après {self.fen_normalized[:30]}… (x{self.count})"


def normalize_fen(fen: str) -> str:
    """Garde les 4 premiers champs du FEN (position, trait, droits roque, en passant)."""
    if not fen:
        return ""
    return " ".join(fen.split(" ")[:4])