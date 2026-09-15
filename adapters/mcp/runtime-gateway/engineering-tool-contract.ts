import {
  ENGINEERING_DECISION_AREAS,
  type EngineeringDecisionArea,
} from '../../../packages/kernel/work/api/index';

export function engineeringDecisionInputKey(area: EngineeringDecisionArea): string {
  return area.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export const ENGINEERING_DECISION_INPUT_ENTRIES = ENGINEERING_DECISION_AREAS.map((area) => ({
  area,
  field: engineeringDecisionInputKey(area),
}));

export const ENGINEERING_DECISION_INPUT_FIELDS = ENGINEERING_DECISION_INPUT_ENTRIES.map(({ field }) => field);
