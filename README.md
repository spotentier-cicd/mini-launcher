# Mini Launcher

[![CI](https://github.com/spotentier-cicd/mini-launcher/actions/workflows/ci.yml/badge.svg)](https://github.com/spotentier-cicd/mini-launcher/actions/workflows/ci.yml)

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
- **Port** : détecté dans trois sources, par ordre de priorité décroissant :
  1. une override `port` dans `config.json` (elle gagne toujours) ;
  2. **l'adresse annoncée par le projet dans sa sortie** (`http://localhost:5173`), lue au
     vol au démarrage, codes couleur compris. C'est la source la plus fiable : c'est le
     port réellement utilisé, pas celui qui est censé l'être ;
  3. un `PORT=...` dans le `.env` du projet.

  La plupart des projets n'ayant pas de `.env`, c'est le point 2 qui fait le gros du
  travail — le bouton **Open** apparaît tout seul quelques secondes après le lancement.

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

- **Start** lance la commande détectée (ou choisie dans le menu déroulant) dans le dossier du projet, comme dans un terminal classique.
- **Restart** prend la place de Start dès qu'un projet tourne : il arrête le process, attend qu'il ait
  réellement rendu la main, puis le relance avec le même script.
- **Stop** tue proprement le process et ses enfants (ex. le process lancé par `npm run dev`).
- **Logs** affiche la sortie standard/erreur en direct, et reste consultable après un plantage.
- **Refresh** force un rafraîchissement immédiat ; en temps normal il n'est pas nécessaire, la page
  se met à jour d'elle-même.

### Les quatre états d'un projet

| Point | État | Signification |
| --- | --- | --- |
| gris | `stopped` | rien ne tourne |
| bleu clignotant | `starting` | lancé par le dashboard, mais rien ne répond encore sur son port |
| turquoise clignotant | `running` | lancé par le dashboard et joignable |
| orange | `external` | un service répond déjà sur ce port sans être géré par le dashboard |

Le bouton **Open** n'est actif qu'en `running` ou `external` : tant que le port ne répond pas, le
lien reste grisé plutôt que de mener à une erreur de connexion. Un projet qui reste bloqué en
`starting` est le signe qu'il n'écoute pas sur le port déclaré dans son `.env`.

### Mise à jour en temps réel

Le navigateur n'interroge plus le serveur en boucle : il ouvre un flux **SSE** sur `/api/events` et
le serveur y pousse les changements d'état et chaque ligne de log au fil de l'eau. Concrètement les
logs s'affichent sans délai, et le serveur ne scanne le disque que tant qu'au moins un onglet est
ouvert. Si le serveur redémarre, le navigateur se reconnecte tout seul.

## Reprise et conflits de port

**Reprise après redémarrage.** Le launcher tient un registre des process lancés dans
`logs/running.json`. Au démarrage il vérifie, pour chaque entrée, que le PID est toujours
vivant et — si le port était connu — qu'il répond encore, avant de revendiquer le process.
Ce double contrôle limite le risque d'adopter un PID réattribué à autre chose.

**Arrêt forcé d'un `external`.** Un projet peut tourner sans que le dashboard l'ait lancé :
démarré depuis un terminal, ou par une instance du launcher antérieure au registre. Il
apparaît alors en `external`. Le bouton **Stop** y reste actif, avec un contour pointillé :
il demande confirmation, puis tue le process qui occupe le port (identifié via `lsof`).

Seul le process qui écoute est visé, pas son groupe — on n'a pas démarré cet arbre, autant
ne pas emporter ce qu'on ne connaît pas. Le launcher refuse de se tuer lui-même : il est
son propre projet scanné dès que `ROOT_DIR` le contient.

Si le projet n'a **aucun port connu**, il apparaît en `stopped` même s'il tourne, et le
dashboard ne peut rien pour lui : ajoute une override `port` dans `config.json` pour le
rendre visible.

**L'environnement du launcher n'est pas transmis.** Les variables de son propre `.env`
(`PORT`, `ROOT_DIR`, `SCAN_DEPTH`, `DASHBOARD_PASSWORD`) sont retirées de l'environnement
des projets lancés. Sans ça, un projet héritait du `PORT` du dashboard et tentait
d'écouter dessus : `dotenv` n'écrase jamais une variable déjà définie, donc le `.env` du
projet était purement ignoré. Chaque projet lit donc bien sa propre configuration, et le
mot de passe du dashboard ne se promène pas dans les process enfants.

**Conflit de port.** Avant de lancer un projet, le port attendu est testé. S'il est déjà
pris, le démarrage est refusé avec un message qui nomme le coupable plutôt que de laisser
le projet mourir sur `EADDRINUSE` deux secondes plus tard :

```
Port 3000 is already in use by node (PID 42988). Free it before starting.
```

L'identification du process repose sur `lsof` ; là où il n'existe pas, le conflit est
signalé sans nommer le coupable.

## TypeScript

Le code est en TypeScript. **Le serveur n'est pas compilé** : Node ≥ 22.18 efface les
types à l'exécution, donc `node server.ts` fonctionne directement. Seul le front doit
l'être, un navigateur ne lisant pas de TypeScript :

```bash
npm run build       # src/app.ts -> public/app.js  (fait aussi par npm start)
npm run build:watch # pendant le développement du front
npm run typecheck   # vérifie serveur, navigateur et tests
```

`public/app.js` est un fichier généré, ignoré par git : éditer `src/app.ts`.

Node ne vérifiant rien à l'exécution, `npm run typecheck` est le seul garde-fou sur les
types. Le CI le lance à chaque push.

## Tests

```bash
npm test
```

La suite tourne aussi **à chaque push** via GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) : Node 22 sur Ubuntu, `npm ci`
puis `npm test`. Le workflow installe `lsof`, dont dépend l'identification du process qui
occupe un port.

Suite d'intégration sous vitest : chaque test démarre un vrai launcher sur un port libre,
avec des projets factices dans un dossier temporaire. Elle couvre l'authentification et le
blocage d'IP, la détection des projets et les overrides, le cycle start/stop/restart, les
conflits de port, le flux SSE, la détection du port dans la sortie, la reprise des
orphelins après un arrêt brutal, et l'isolation de l'environnement des projets.

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

- Les projets lancés par le dashboard **survivent** à son arrêt (ils sont détachés). Au
  redémarrage, le launcher les reprend en main grâce à `logs/running.json` : ils
  réapparaissent en `running` et restent arrêtables. Seuls leurs logs de la session
  précédente sont perdus, ce que le panneau Logs indique explicitement.
- Prévu pour tourner en local. L'accès est protégé par mot de passe, mais le trafic reste en HTTP
  en clair : derrière un reverse proxy TLS si tu l'exposes hors de ta machine.
- Tant qu'un onglet est ouvert, le serveur relit les `package.json` toutes les 2 secondes (léger, mais évite un `ROOT_DIR` avec des milliers de sous-dossiers). Aucun onglet ouvert, aucun scan.
