import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { Command } from 'commander';
import { runForgeRuntimeService } from './service-runner';

export async function runForgeRuntimeServiceCli(argv = process.argv): Promise<void> {
  const command = new Command('forge-runtime-service')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--config <path>', 'Forge Runtime service configuration');
  command.parse(argv);
  const options = command.opts<{ controllerHome: string; config: string }>();
  process.exitCode = await runForgeRuntimeService(resolve(options.controllerHome), resolve(options.config));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runForgeRuntimeServiceCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
