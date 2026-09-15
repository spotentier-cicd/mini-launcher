// Contrat partagé entre le serveur et le navigateur. Un `.d.ts` n'émet aucun
// JavaScript : le fichier sert uniquement à ce que les deux côtés du flux SSE
// se réfèrent à la même forme de données.

export type Status = "running" | "starting" | "external" | "stopped";

/** Un projet enrichi de son état, tel que poussé par l'évènement `projects`. */
export interface ProjectState {
  id: string;
  name: string;
  cwd: string;
  scripts: string[];
  defaultScript: string | null;
  port: number | null;
  url: string | null;
  status: Status;
  pid: number | null;
  startedAt: number | null;
  adopted: boolean;
  command?: string;
  args?: string[];
}

/** Charge utile de l'évènement `log`. */
export interface LogEvent {
  id: string;
  seq: number;
  chunk: string;
}

/** Charge utile de l'évènement `failure`. */
export interface FailureEvent {
  error: string;
}

/** Réponse de `GET /api/projects/:id/logs`. */
export interface LogsResponse {
  logs: string[];
  seq: number;
}
