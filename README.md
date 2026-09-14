# Mini Launcher

Un petit tableau de bord local qui **détecte automatiquement** tes projets Node (Express, Hono, etc.) dans un dossier, et permet de les lancer/arrêter/ouvrir depuis une seule page.

## Installation

```bash
cd mini-launcher
npm install
```

## Configuration

Édite `config.json` :

```json
{
  "rootDir": "/chemin/vers/le/dossier/qui-contient-tes-projets",
  "scanDepth": 2,
  "overrides": {}
}
```

- **`rootDir`** : le dossier parent qui contient tous tes petits projets (chacun dans son propre sous-dossier).
- **`scanDepth`** : jusqu'à combien de niveaux de sous-dossiers explorer avant de considérer qu'il n'y a pas de projet (2 par défaut : ça couvre `rootDir/projet` et `rootDir/groupe/projet`).

Le scan est automatique : tout dossier contenant un `package.json` est détecté comme projet, `node_modules`, `.git`, `dist`, `build` etc. sont ignorés. Pas besoin de relancer le serveur après avoir ajouté un nouveau projet, il sera repris au prochain rafraîchissement de la page.

### Comment un projet est détecté

- **Nom** : le champ `name` du `package.json`, sinon le nom du dossier.
- **Commande** : le script `dev`, sinon `start`, sinon `serve` (dans cet ordre de préférence). S'il y a plusieurs scripts candidats, un menu déroulant apparaît pour choisir lequel lancer.
- **Port** : lu depuis un fichier `.env` du projet (`PORT=...`). Si absent, le port reste inconnu et le bouton "Ouvrir" est masqué.

### Personnaliser un projet détecté (overrides)

Si le nom, le port ou la commande auto-détectés ne conviennent pas, ajoute une entrée dans `overrides`, avec pour clé l'identifiant du projet (visible dans les logs serveur, ou déductible du chemin relatif à `rootDir` — les `/` deviennent `__`) :

```json
{
  "rootDir": "/chemin/vers/tes/projets",
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

## Lancer le dashboard

```bash
npm start
```

Puis ouvre **http://localhost:7777**.

Pour changer le port du dashboard lui-même :

```bash
LAUNCHER_PORT=8000 npm start
```

## Fonctionnement

- **Démarrer** lance la commande détectée (ou choisie dans le menu déroulant) dans le dossier du projet, comme dans un terminal classique.
- **Arrêter** tue proprement le process et ses enfants (ex. le process lancé par `npm run dev`).
- **Logs** affiche la sortie standard/erreur en direct.
- Couleur du point : gris = arrêté, turquoise = lancé par le dashboard, orange = un service répond déjà sur ce port sans être géré par le dashboard.

## Limites à connaître

- Si tu fermes le process `mini-launcher`, les projets qu'il a lancés s'arrêtent aussi.
- Fonctionne en local, sans authentification : à ne pas exposer publiquement tel quel.
- Le scan lit chaque `package.json` à chaque rafraîchissement (léger, mais évite un `rootDir` avec des milliers de sous-dossiers).
