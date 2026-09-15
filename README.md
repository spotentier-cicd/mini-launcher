# Mini Launcher

Un petit tableau de bord local qui **détecte automatiquement** tes projets Node (Express, Hono, etc.) dans un dossier, et permet de les lancer/arrêter/ouvrir depuis une seule page.

## Installation

```bash
cd mini-launcher
npm install
```

## Configuration

Copie `.env.example` en `.env` et renseigne-le :

```bash
cp .env.example .env
```

| Variable | Rôle |
| --- | --- |
| `PORT` | port du dashboard lui-même (7777 par défaut) |
| `ROOT_DIR` | dossier parent qui contient tous tes petits projets (chacun dans son propre sous-dossier) |
| `SCAN_DEPTH` | jusqu'à combien de niveaux de sous-dossiers explorer avant de considérer qu'il n'y a pas de projet (2 par défaut : ça couvre `ROOT_DIR/projet` et `ROOT_DIR/groupe/projet`) |
| `DASHBOARD_PASSWORD` | mot de passe d'accès au dashboard (voir plus bas) |

`config.json` ne sert plus qu'aux `overrides` (voir plus bas).

Le scan est automatique : tout dossier contenant un `package.json` est détecté comme projet, `node_modules`, `.git`, `dist`, `build` etc. sont ignorés. Pas besoin de relancer le serveur après avoir ajouté un nouveau projet, il sera repris au prochain rafraîchissement de la page.

### Comment un projet est détecté

- **Nom** : le champ `name` du `package.json`, sinon le nom du dossier.
- **Commande** : le script `dev`, sinon `start`, sinon `serve` (dans cet ordre de préférence). S'il y a plusieurs scripts candidats, un menu déroulant apparaît pour choisir lequel lancer.
- **Port** : lu depuis un fichier `.env` du projet (`PORT=...`). Si absent, le port reste inconnu et le bouton "Ouvrir" est masqué.

### Personnaliser un projet détecté (overrides)

Si le nom, le port ou la commande auto-détectés ne conviennent pas, ajoute une entrée dans `overrides`, avec pour clé l'identifiant du projet (visible dans les logs serveur, ou déductible du chemin relatif à `ROOT_DIR` — les `/` deviennent `__`) :

```json
{
  "overrides": {
    "mon-dossier__sous-dossier": {
      "name": "API interne",
      "port": 4500,
      "url": "http://localhost:4500",
      "command": "pnpm",
      "args": ["start"]
    }
  }
}
```

Tous les champs d'une override sont optionnels ; seuls ceux fournis remplacent la valeur auto-détectée. Si `command` est fourni, le menu déroulant de scripts npm disparaît (la commande est fixe).

## Mot de passe d'accès

Le dashboard peut lancer et arrêter des process sur ta machine : il est protégé par un
mot de passe, défini dans `.env` :

```
DASHBOARD_PASSWORD=ton-mot-de-passe
```

À la première visite, une page de connexion demande ce mot de passe. Une fois validé,
un cookie de session (`HttpOnly`, `SameSite=Strict`, valable 12 h) est posé ; le bouton
**Log out** de l'en-tête le révoque. Après 8 tentatives ratées, les connexions depuis
cette IP sont bloquées 5 minutes.

Tout est protégé — pages, assets et API — sauf la page de connexion elle-même.
Les sessions vivent en mémoire : redémarrer le serveur déconnecte tout le monde.

> **Laisser `DASHBOARD_PASSWORD` vide désactive complètement l'authentification.**
> Le serveur l'affiche alors en garde au démarrage.

`.env` est dans `.gitignore` : ton mot de passe ne part pas dans le dépôt.

## Lancer le dashboard

```bash
npm start
```

Puis ouvre **http://localhost:7777**.

Pour changer le port du dashboard lui-même, ajuste `PORT` dans `.env`.

## Fonctionnement

- **Démarrer** lance la commande détectée (ou choisie dans le menu déroulant) dans le dossier du projet, comme dans un terminal classique.
- **Arrêter** tue proprement le process et ses enfants (ex. le process lancé par `npm run dev`).
- **Logs** affiche la sortie standard/erreur en direct.
- Couleur du point : gris = arrêté, turquoise = lancé par le dashboard, orange = un service répond déjà sur ce port sans être géré par le dashboard.

## Journal des erreurs

Les problèmes sont écrits dans **`logs/error.log`** (créé automatiquement, ignoré par git),
en clair et horodatés :

```
2026-09-15 12:57:24 [ERROR] Projet « crasher » terminé en erreur (code 1)
$ npm run dev
démarrage…
Error: impossible de se connecter à la base (ECONNREFUSED 5432)
--- processus terminé (code 1) --- {"command":"npm run dev","cwd":"/…/crasher"}
```

Ce qui y atterrit :

- un projet qui se termine avec un code non nul, **avec les 15 dernières lignes de sa sortie** ;
- un projet impossible à lancer (commande introuvable, dossier disparu) ;
- `config.json` illisible ou `ROOT_DIR` inexistant ;
- les mots de passe invalides et les blocages d'IP, avec l'IP concernée ;
- toute exception non catchée ou promesse rejetée, stack comprise.

Le fonctionnement normal (démarrages, arrêts) reste sur la sortie console et n'encombre
pas le fichier. La sortie courante d'un projet se lit dans l'interface via le bouton
**Logs** — elle reste consultable après un plantage.

Rotation automatique : 5 fichiers de 1 Mo maximum, le plus récent étant toujours
`error.log`. Rien à purger à la main.

Une exception non catchée est journalisée puis le serveur s'arrête (comportement par
défaut de Node). Une promesse rejetée est journalisée mais n'arrête pas le serveur, pour
ne pas emporter les projets en cours d'exécution.

## Limites à connaître

- Si tu fermes le process `mini-launcher`, les projets qu'il a lancés s'arrêtent aussi.
- Prévu pour tourner en local. L'accès est protégé par mot de passe, mais le trafic reste en HTTP
  en clair : derrière un reverse proxy TLS si tu l'exposes hors de ta machine.
- Le scan lit chaque `package.json` à chaque rafraîchissement (léger, mais évite un `ROOT_DIR` avec des milliers de sous-dossiers).
