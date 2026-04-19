from django.urls import path, include

urlpatterns = [
    path("", include("repertoire.urls")),
]
