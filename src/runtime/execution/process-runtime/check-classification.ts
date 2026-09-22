import {
  controllerCheckSelection,
  type ControllerCheck,
} from '../../../cli/controller/check-runner';

export type ControllerCheckExecutionClass = 'ordinary' | 'release' | 'live_controller_home';

export interface ControllerCheckExecutionClassification {
  executionClass: ControllerCheckExecutionClass;
  requiresDurableWorkflow: boolean;
  reason: 'ordinary_process_check' | 'release_phase' | 'live_controller_home';
}

/**
 * Single semantic authority for Check execution placement.
 *
 * A caller must supply a registered ControllerCheck. Human-readable ids and
 * descriptions are not lifecycle authority here. Compatibility inference, when
 * unavoidable at repository ingress, must already have been normalized into
 * the ControllerCheck contract before classification reaches this layer.
 */
export function classifyControllerCheckExecution(check: ControllerCheck): ControllerCheckExecutionClassification {
  if (check.executionAuthority === 'live_controller_home') {
    return {
      executionClass: 'live_controller_home',
      requiresDurableWorkflow: true,
      reason: 'live_controller_home',
    };
  }

  if (controllerCheckSelection(check).phases.includes('release')) {
    return {
      executionClass: 'release',
      requiresDurableWorkflow: true,
      reason: 'release_phase',
    };
  }

  return {
    executionClass: 'ordinary',
    requiresDurableWorkflow: false,
    reason: 'ordinary_process_check',
  };
}

export function registeredCheckRequiresDurableWorkflow(check?: ControllerCheck): boolean {
  return check ? classifyControllerCheckExecution(check).requiresDurableWorkflow : false;
}
