from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "change-me-in-production"

DEBUG = True

ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "repertoire",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "chess_repertoire.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
            ],
        },
    },
]

WSGI_APPLICATION = "chess_repertoire.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

SESSION_ENGINE = "django.contrib.sessions.backends.file"
SESSION_FILE_PATH = BASE_DIR / "sessions"
SESSION_FILE_PATH.mkdir(exist_ok=True)

STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ── Répertoires d'ouvertures ────────────────────────────────────────────────────
# Dossier où sont stockés les fichiers JSON générés par le script de génération.
# Modifie ce chemin selon ton environnement.
REPERTOIRES_DIR = BASE_DIR / "repertoires_data"

# ── API Chess.com (pour la vue "Se corriger") ──────────────────────────────────
# Chess.com exige un User-Agent avec une info de contact (email), sinon 403.
# Remplace par ton adresse email pour que Chess.com puisse te contacter en cas
# de problème avec l'usage de leur API.
CHESS_COM_USER_AGENT = "ChessRepertoireApp/1.0 (contact: nicodeme.corentin@gmail.com)"