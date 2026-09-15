const fs = require("node:fs");
const path = require("node:path");
const winston = require("winston");

const LOG_DIR = path.join(__dirname, "logs");
const ERROR_LOG = path.join(LOG_DIR, "error.log");

fs.mkdirSync(LOG_DIR, { recursive: true });

// Une ligne lisible à l'œil plutôt que du JSON : ce fichier est fait pour être
// ouvert dans un éditeur, pas pour être parsé.
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} [${level.toUpperCase()}] ${message}${details}${stack ? `\n${stack}` : ""}`;
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
        winston.format.printf(({ level, message }) => `${level}: ${message}`)
      ),
    }),
  ],
});

// Les handlers natifs de winston écrivent leur propre dump JSON (os, process,
// trace…) en ignorant le format ci-dessus. On les gère à la main pour garder
// le fichier homogène.
process.on("uncaughtException", (err) => {
  logger.error("Exception non catchée — arrêt du serveur", err);
  logger.on("finish", () => process.exit(1));
  logger.end();
});

// Une promesse rejetée ne doit pas emporter les projets en cours d'exécution :
// on l'enregistre et on continue.
process.on("unhandledRejection", (reason) => {
  logger.error(
    "Promesse rejetée sans handler",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

logger.logPath = ERROR_LOG;

module.exports = logger;
