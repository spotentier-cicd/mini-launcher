const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const winston = require("winston") as typeof import("winston");

type Logger = import("winston").Logger & { logPath: string; logDir: string };

/**
 * `${valeur}` sur un objet donne « [object Object] ». winston accepte n'importe
 * quoi comme message, donc on rend quelque chose de lisible dans tous les cas.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[objet non sérialisable]"; // référence circulaire
    }
  }
  return String(value as number | boolean | bigint | symbol | null | undefined);
}

/** Ce que winston passe à un formateur `printf`. */
type LogInfo = {
  level: string;
  message: unknown;
  timestamp?: string;
  stack?: string;
  [key: string]: unknown;
};

// Surchargeable pour que les tests n'écrivent pas dans le dossier du projet.
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const ERROR_LOG = path.join(LOG_DIR, "error.log");

fs.mkdirSync(LOG_DIR, { recursive: true });

// Une ligne lisible à l'œil plutôt que du JSON : ce fichier est fait pour être
// ouvert dans un éditeur, pas pour être parsé.
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }: LogInfo) => {
    const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    const trace = stack ? `\n${stack}` : "";
    return `${timestamp} [${level.toUpperCase()}] ${describe(message)}${details}${trace}`;
  })
);

const logger = winston.createLogger({
  level: "info",
  transports: [
    // Le fichier ne retient que les problèmes (warn et error).
    // Rotation par taille : 5 fichiers de 1 Mo, le plus récent restant error.log.
    new winston.transports.File({
      filename: ERROR_LOG,
      level: "warn",
      format: fileFormat,
      maxsize: 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }: LogInfo) => `${level}: ${describe(message)}`)
      ),
    }),
  ],
});

// Les handlers natifs de winston écrivent leur propre dump JSON (os, process,
// trace…) en ignorant le format ci-dessus. On les gère à la main pour garder
// le fichier homogène.
process.on("uncaughtException", (err: Error) => {
  logger.error("Exception non catchée — arrêt du serveur", err);
  logger.on("finish", () => process.exit(1));
  logger.end();
});

// Une promesse rejetée ne doit pas emporter les projets en cours d'exécution :
// on l'enregistre et on continue.
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    "Promesse rejetée sans handler",
    reason instanceof Error ? reason : new Error(describe(reason))
  );
});

const exported = logger as Logger;
exported.logPath = ERROR_LOG;
exported.logDir = LOG_DIR;

module.exports = exported;
