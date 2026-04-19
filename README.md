# Répertoire d'ouvertures — Application Django

## Installation rapide

```bash
git clone <repo> && cd chess_repertoire
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Ouvrir http://localhost:8000

## Ajouter un répertoire

Copier le JSON produit par le script de génération dans `repertoires_data/`.
Le site le détecte automatiquement sans redémarrer.

## Structure

```
chess_repertoire/
├── chess_repertoire/       # Config Django
│   ├── settings.py         # REPERTOIRES_DIR à configurer ici
│   └── urls.py
├── repertoire/             # App principale
│   ├── scanner.py          # Détection + lecture des JSON
│   ├── filter.py           # Élagage par cumulative_frequency
│   ├── training.py         # Moteur d'entraînement pondéré
│   └── views.py            # 8 endpoints REST
├── repertoires_data/       # Dépôt des fichiers JSON générés
├── static/
│   ├── css/main.css
│   ├── js/
│   │   ├── target.js       # Vue cible concentrique
│   │   ├── tree.js         # Arbre déroulant (sidebar)
│   │   ├── training.js     # Interface d'entraînement
│   │   └── main.js         # Orchestrateur + BOARD partagé
│   └── img/chesspieces/    # SVG des pièces (générés)
├── templates/
└── test_backend.py         # 20 tests unitaires
```

## Endpoints API

| Méthode | URL | Description |
|---------|-----|-------------|
| GET  | `/api/repertoires/`         | Liste + métadonnées des répertoires |
| GET  | `/api/tree/<slug>/?freq=`   | Arbre filtré par fréquence |
| POST | `/api/training/start/`      | Démarre une ligne |
| POST | `/api/training/move/`       | Joue un coup `{"move_uci":"e2e4"}` |
| POST | `/api/training/hint/`       | Indice (révèle le coup attendu) |
| POST | `/api/training/lock/`       | Verrouille/déverrouille une position |
| GET  | `/api/training/state/`      | État courant de session |

## Fonctionnalités

### Visualisation
- **Arbre déroulant** (sidebar) — nos coups en bleu, coups adverses en gris,
  fréquences, badge de transposition `≡`
- **Cible concentrique** (panel droit) — 3 anneaux : central = coup joué,
  milieu = coups disponibles (taille proportionnelle à la fréquence),
  extérieur = prévisualisation
- **Échiquier synchronisé** (centre) — se met à jour à chaque clic dans
  l'arbre ou la cible

### Entraînement
- Lignes tirées au sort pondérées par `cumulative_frequency`
- Coups adverses joués automatiquement (pondérés par fréquence locale)
- **Erreur** → pièce remise en place, highlight rouge, bon coup affiché ;
  la ligne continue (il faut jouer le bon coup pour avancer)
- **Indice** → highlight vert du coup à jouer
- **Navigation clavier** `←`/`→` pour rembobiner/avancer sur la ligne ;
  clic sur un coup dans la notation pour aller directement à cette position
- **Auto-enchaînement** — toggle pour démarrer une nouvelle ligne
  automatiquement (avec message de fin 1.2s)
- **Verrou de position** — toutes les lignes partiront de cette position

### Filtre de fréquence (slider header)
Filtre l'arbre et les lignes d'entraînement : seuls les nœuds dont
`cumulative_frequency ≥ seuil` sont visibles et jouables.

## Déploiement VPS (Nginx + Gunicorn)

```bash
pip install gunicorn
python manage.py collectstatic
gunicorn chess_repertoire.wsgi:application --bind 127.0.0.1:8000 --workers 3
```

```nginx
server {
    listen 80;
    server_name ton-domaine.com;
    location /static/ { alias /chemin/chess_repertoire/staticfiles/; }
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Modifier REPERTOIRES_DIR

Dans `chess_repertoire/settings.py` :
```python
REPERTOIRES_DIR = Path("/data/mes_repertoires")
```

## Tests

```bash
python3 test_backend.py   # 20 tests, sans Django ni python-chess
```
