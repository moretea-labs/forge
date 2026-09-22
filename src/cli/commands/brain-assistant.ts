import { readFileSync, statSync } from 'fs';
import type { Command } from 'commander';
import { recordExperience, retractExperience, supersedeExperience, type ExperienceDraft } from '../../../packages/kernel/memory/api/index';
import { controllerExperienceStore } from '../../runtime/control-plane/persistence/experience-store';
import { prepareAssistantWorkContext } from '../../runtime/context/assistant-work-context';

function readBoundedJson(path: string): unknown {
  if (statSync(path).size > 16 * 1024) throw new Error('BRAIN_INPUT_TOO_LARGE');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Thin CLI over the same APIs used by Controller rounds. No independent memory writer. */
export function addBrainAssistantCommands(brain: Command): void {
  brain.command('recall').description('Resolve registered project knowledge and retained experience for an existing Work')
    .requiredOption('--controller-home <path>').requiredOption('--repo-id <id>').requiredOption('--work-id <id>')
    .option('--query <text>').option('--channel <id>').option('--account <id>').option('--locale <id>')
    .action((options: { controllerHome: string; repoId: string; workId: string; query?: string; channel?: string; account?: string; locale?: string }) => {
      console.log(JSON.stringify(prepareAssistantWorkContext({ ...options, applicability: { channel: options.channel, account: options.account, locale: options.locale } }) ?? { status: 'project_contract_missing' }, null, 2));
    });
  const experience = brain.command('experience').description('Submit or withdraw Controller-authored, evidence-backed experience');
  for (const operation of ['record', 'supersede', 'retract'] as const) {
    experience.command(operation)
      .requiredOption('--controller-home <path>').requiredOption('--repo-id <id>').requiredOption('--work-id <id>')
      .requiredOption('--controller-id <id>').requiredOption('--authority-env <name>', 'Environment variable containing the current Controller capability')
      .requiredOption('--input <path>', 'Bounded JSON API input; never include the Controller capability')
      .action((options: { controllerHome: string; repoId: string; workId: string; controllerId: string; authorityEnv: string; input: string }) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.authorityEnv)) throw new Error('BRAIN_AUTHORITY_ENV_INVALID');
        const authorityId = process.env[options.authorityEnv];
        if (!authorityId) throw new Error('BRAIN_CONTROLLER_AUTHORITY_REQUIRED');
        const store = controllerExperienceStore({ ...options, identity: { workId: options.workId, controllerId: options.controllerId, authorityId } });
        const data = readBoundedJson(options.input);
        const result = operation === 'record' ? recordExperience(store, data as ExperienceDraft)
          : operation === 'supersede' ? supersedeExperience(store, data as Parameters<typeof supersedeExperience>[1])
            : retractExperience(store, data as Parameters<typeof retractExperience>[1]);
        console.log(JSON.stringify(result, null, 2));
      });
  }
}
