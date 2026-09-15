# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ce que fait l'outil

Tableau de bord local qui **détecte, lance et arrête d'autres projets Node**. Le serveur
est donc à la fois une application web et un superviseur de process enfants : toute
modification touche l'un ou l'autre, rarement les deux au même endroit.

## Commandes

```bash
npm start          # démarre le dashboard (port depuis .env, 7777 par défaut)
```

Aucun build, aucun bundler, aucune étape de compilation : `public/` est servi tel quel.

```bash
npm test                              # toute la suite (vitest)
npx vitest run tests/auth.test.js     # un seul fichier
npx vitest run -t "réadopte"          # un seul test, par son nom
npm run test:watch                    # mode veille
```

Les tests sont **d'intégration** : chacun démarre un vrai `server.js` en process enfant,
sur un port libre, avec un `ROOT_DIR` temporaire rempli de faux projets. Rien n'est moqué,
donc ils couvrent ce qui casse réellement ici — spawn, ports, sessions, flux SSE.

`tests/helpers.js` porte tout le harnais : `startLauncher()` (démarre et attend l'écoute),
`addProject()` (fabrique un faux projet), `waitFor()` (attente sur condition, jamais de
`sleep`), `cleanupAll()`.

Deux points à respecter en ajoutant un test :

- **Toujours `afterEach(cleanupAll)`.** Les projets sont lancés `detached` : sans
  `stopProjects()`, tuer le launcher les laisse tourner et la suite fuit des process.
- **Jamais de port en dur** — `freePort()`. Les fichiers tournent en série
  (`fileParallelism: false`) mais les ports restent alloués dynamiquement.

Le harnais impose deux surcharges au serveur, `LOG_DIR` et `CONFIG_PATH`, pour qu'aucun
test n'écrive dans `logs/` ni ne lise le `config.json` du dépôt.

Pour une capture d'écran en headless : utiliser `--timeout=2500`, **pas**
`--virtual-time-budget`. Le flux SSE reste ouvert en permanence, donc le temps virtuel
n'avance jamais et Chrome ne rend jamais la main.

`--screenshot` convient pour constater un rendu, mais **pas pour scénariser une
interaction** : la page ne vit pas de façon fiable jusqu'au bout d'une séquence de clics,
et `--dump-dom` vide le DOM dès le `load`, avant tout `setTimeout`. Pour tester un
parcours (ouvrir un modal, confirmer, vérifier la requête), piloter le navigateur par le
protocole DevTools — Chrome avec `--remote-debugging-port`, puis `Runtime.evaluate` avec
`awaitPromise` depuis Node, dont le `WebSocket` global suffit. C'est la seule méthode
déterministe ici ; plusieurs faux négatifs ont déjà été imputés à tort au code applicatif.

## Configuration : le piège

`loadConfig()` lit `config.json`, **mais n'en tire que `overrides`**. `rootDir` et
`scanDepth` viennent de `.env` (`ROOT_DIR`, `SCAN_DEPTH`) malgré ce que suggère le nom de
la fonction et d'anciennes versions du README. Les variables sont déclarées en tête de
`server.js`. `.env` est suivi par git — attention à ce qu'on y écrit.

## Architecture

### Le flux SSE est le seul canal de mise à jour

Le navigateur **ne fait aucun polling**. Il ouvre `/api/events` et le serveur y pousse
trois types d'évènements : `projects` (état complet), `log` (un chunk de sortie) et
`failure` (erreur de configuration).

Conséquence directe : **toute mutation d'état côté serveur doit appeler `pushState()`**,
sinon l'interface ne bouge pas. C'est le piège principal en ajoutant une route.

`pushState()` ne fait rien si aucun client n'est connecté, et ne diffuse que si le JSON a
changé depuis le dernier envoi (`lastStateJson`). La boucle de scan (`startStateLoop` /
`stopStateLoop`) n'existe que tant que `sseClients` est non vide : sans onglet ouvert, le
serveur ne lit pas le disque.

### `running` et `logsById` sont volontairement séparés

- `running` : uniquement les process vivants. Pilote le statut et le `pid`.
- `logsById` : **survit à la sortie du process**, pour pouvoir lire la cause d'un crash.

Les fusionner réintroduit un bug déjà corrigé (les logs disparaissaient au moment précis
où on voulait les lire).

Une entrée de `running` vaut `{ pid, startedAt, script, proc, adopted }`. **`proc` est
`null` pour un process réattaché** au démarrage : ne jamais écrire `entry.proc.pid`, mais
`entry.pid`. Tout code qui écoute `entry.proc.once("exit")` doit prévoir le cas `adopted`
(`stopProject()` surveille alors le PID par sondage).

`pushLog()` est le seul point d'entrée pour ajouter de la sortie : il incrémente `logSeq`
(compteur monotone par projet) et diffuse le chunk. Le client compare les numéros, détecte
un trou et se resynchronise via `GET /api/projects/:id/logs`, qui renvoie `{ logs, seq }`.

### Les quatre statuts

Calculés dans `computeState()` en croisant « lancé par nous » et « le port répond » :

| | port répond | port muet / inconnu |
| --- | --- | --- |
| **lancé par le dashboard** | `running` | `starting` |
| **non lancé par nous** | `external` | `stopped` |

`starting` existe pour que le bouton **Open** ne pointe pas vers un serveur qui n'écoute
pas encore. `watchUntilReady()` sonde le port toutes les 400 ms pendant 30 s après un
lancement afin de basculer sans attendre le tour de boucle suivant.

### D'où vient le port

Trois sources, par priorité : override `config.json` (marquée `pinnedPort`, gagne
toujours) > **`detectedPorts`**, alimentée par `detectPortFromOutput()` qui lit
`http://localhost:PORT` dans la sortie du projet > le `PORT` du `.env`. La détection
supprime les codes ANSI avant de chercher, sinon les URL colorées de Vite échappent à la
regex. La plupart des projets n'ayant pas de `.env`, c'est cette détection qui rend le
bouton Open utilisable.

### Reprise des orphelins

Les enfants sont lancés `detached`, donc ils **survivent à l'arrêt du launcher** (vérifié).
Sans reprise ils réapparaissent en `external`, où Stop est désactivé — l'outil oblige alors
à ouvrir un terminal, ce qu'il est censé éviter.

`persistRunning()` écrit `logs/running.json` à chaque changement, **y compris depuis
`detectPortFromOutput()`** : le port sert de garde-fou anti-réutilisation de PID au
redémarrage, il doit donc être dans le registre. `recoverOrphans()` n'adopte un PID que
s'il est vivant et, quand un port était connu, qu'il répond toujours.

### Arrêt d'un process non géré

`POST /api/projects/:id/stop` avec `{ force: true }` tue ce qui occupe le port quand le
projet n'est pas dans `running` (statut `external`). Sans `force`, la route répond 404
comme avant. Deux garde-fous : seul le PID qui écoute est visé (pas son groupe), et le
launcher **refuse de tuer son propre PID** — il apparaît lui-même en `external` sur son
port dès que `ROOT_DIR` le contient, donc sans ce contrôle un clic suffirait à le tuer.

### L'environnement du launcher est filtré avant le spawn

`childEnv()` retire de `process.env` les clés du `.env` du launcher (plus `PORT`,
`ROOT_DIR`, `SCAN_DEPTH`, `DASHBOARD_PASSWORD` en dur) avant de les passer à un enfant.
**Ne jamais revenir à `env: { ...process.env }`** : `dotenv` n'écrase pas une variable déjà
définie, donc un `PORT` hérité gagne sur le `.env` du projet, qui se met à écouter sur le
port du dashboard et meurt en `EADDRINUSE`. Le mot de passe fuitait aussi dans chaque
process enfant.

### Contrôle de port avant lancement

`spawnProject()` est `async` uniquement pour ce contrôle : si le port attendu répond déjà,
le démarrage est refusé en 409 avec le process coupable identifié via `lsof`. Vérifié que
ça ne casse pas le restart — le socket est libéré dès la sortie du process.

### L'ordre des middlewares d'authentification est critique

La barrière est un `app.use()` au milieu de `server.js`. Tout ce qui est enregistré
**avant** est public (`/login`, `/logout`, `/api/session`) ; tout ce qui vient **après**
exige une session — y compris `express.static`. Une nouvelle route placée trop haut
devient publique par accident.

`OPEN_PATHS` liste les exceptions (`/login`, `/style.css`, `/favicon.ico`). Les sessions
vivent en mémoire : un redémarrage déconnecte tout le monde. `DASHBOARD_PASSWORD` vide
désactive entièrement l'authentification.

### Front : vanilla, contrat par sélecteurs

Pas de framework. `renderRow()` clone `#row-template` et remplit par classes. Ces
sélecteurs forment un **contrat entre `index.html` et `app.js`** ; en renommer un dans le
markup casse le rendu silencieusement :

```
.row-name  .row-path  .row-port  .open  .script-select
.start  .start-label  .icon-start  .icon-restart  .stop  .logs-toggle  .logs
```

Le board est intégralement re-rendu à chaque évènement `projects`. C'est acceptable parce
que ces évènements n'arrivent que sur changement réel.

**Start et Restart partagent un seul bouton** (`.start`) : `setAction()` permute les icônes
et le libellé selon l'état.

### Journalisation

`logger.js` (winston) : `logs/error.log` reçoit `warn` et au-dessus, la console reçoit
`info` et au-dessus. Le fonctionnement normal n'encombre donc pas le fichier.

Les `exceptionHandlers` natifs de winston **ne sont volontairement pas utilisés** : ils
écrivent leur propre dump JSON en ignorant le format configuré. Des handlers
`process.on("uncaughtException" / "unhandledRejection")` les remplacent dans `logger.js`.

## Pièges rencontrés

- **`hidden` sur un `<svg>` ne marche pas.** C'est une propriété de `HTMLElement` ;
  `svg.hidden = false` crée un expando sans toucher l'attribut. Utiliser
  `toggleAttribute("hidden", bool)`.
- **`[hidden] { display: none !important }`** est nécessaire dans `style.css` : `.btn` et
  `.icon` posent leur propre `display`, qui écrase la feuille du navigateur.
- **Le scroll des logs ne doit recoller en bas que si on y était déjà**, sinon la vue est
  arrachée à quelqu'un qui est remonté lire une erreur.
- `child.on("exit")` reçoit `code === null` quand le process est tué par signal.

## Convention de commit

`type(MNLCH-N): description` — une seule ligne, description en anglais minuscule, `N`
incrémenté à chaque commit. Exemples réels :

```
feat(MNLCH-8): sse live updates, ready state, restart button
fix(MNLCH-6): logs in flight refresh
```

Branche de travail : `dev`. Branche principale : `main`.

## Point ouvert

`app.listen(PORT, …)` n'a pas d'argument d'hôte : le dashboard écoute sur toutes les
interfaces alors qu'il exécute des commandes arbitraires. Signalé, non corrigé — le
correctif est `app.listen(PORT, "127.0.0.1", …)`.
