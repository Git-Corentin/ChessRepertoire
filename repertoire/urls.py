from django.urls import path
from . import views

urlpatterns = [
    # Shell HTML principal
    path("", views.index, name="index"),

    # API REST
    path("api/repertoires/", views.api_repertoires, name="api_repertoires"),
    path("api/tree/<str:slug>/", views.api_tree, name="api_tree"),

    # Entraînement
    path("api/training/start/", views.api_training_start, name="api_training_start"),
    path("api/training/move/", views.api_training_move, name="api_training_move"),
    path("api/training/hint/", views.api_training_hint, name="api_training_hint"),
    path("api/training/lock/", views.api_training_lock, name="api_training_lock"),
    path("api/training/state/", views.api_training_state, name="api_training_state"),

    # Se corriger
    path("api/correct/fetch/",        views.api_correct_fetch,        name="api_correct_fetch"),
    path("api/correct/save-error/",   views.api_correct_save_error,   name="api_correct_save_error"),
    path("api/correct/my-errors/",    views.api_correct_my_errors,    name="api_correct_my_errors"),
    path("api/correct/delete-error/", views.api_correct_delete_error, name="api_correct_delete_error"),

    # S'entraîner sur ses erreurs
    path("api/training/start-from-errors/", views.api_training_start_from_errors, name="api_training_start_from_errors"),
]