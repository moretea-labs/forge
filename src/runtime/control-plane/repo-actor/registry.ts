import { RepoActor } from './actor';

export class RepoActorRegistry {
  private readonly controllerHome: string;
  private readonly defaultMaxConcurrentWorkers: number;
  private readonly actors = new Map<string, RepoActor>();
  constructor(controllerHome: string, options: { maxConcurrentWorkers?: number } = {}) {
    this.controllerHome = controllerHome;
    this.defaultMaxConcurrentWorkers = Math.max(1, options.maxConcurrentWorkers ?? 4);
  }

  get(repoId: string): RepoActor {
    let actor = this.actors.get(repoId);
    if (!actor) {
      actor = new RepoActor(this.controllerHome, repoId, {
        maxConcurrentWorkers: Number(process.env.FORGE_PER_REPO_WORKERS ?? this.defaultMaxConcurrentWorkers),
      });
      this.actors.set(repoId, actor);
    }
    return actor;
  }
}
