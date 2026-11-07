import type { Command } from 'commander';
import { prepareAssistantWorkContext } from '../../runtime/context/assistant-work-context';

/**
 * Historical read-only assistant context. Work-authored memory/experience
 * mutations were retired with Work lifecycle authority; new learning uses
 * cognition_settlement with Project/Requirement/Workspace scope.
 */
export function addBrainAssistantCommands(brain: Command): void {
  brain.command('recall')
    .description('Read retained project knowledge and historical experience for an existing legacy Work')
    .requiredOption('--controller-home <path>')
    .requiredOption('--repo-id <id>')
    .requiredOption('--work-id <id>')
    .option('--query <text>')
    .option('--channel <id>')
    .option('--account <id>')
    .option('--locale <id>')
    .action((options: { controllerHome: string; repoId: string; workId: string; query?: string; channel?: string; account?: string; locale?: string }) => {
      console.log(JSON.stringify(
        prepareAssistantWorkContext({
          ...options,
          applicability: { channel: options.channel, account: options.account, locale: options.locale },
        }) ?? { status: 'project_contract_missing' },
        null,
        2,
      ));
    });
}
