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
]
