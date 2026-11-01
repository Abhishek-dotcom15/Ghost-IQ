import type { AgentAction, Behavior, BehaviorType, StepKind } from '@ghostiq/shared';
import type { Rng } from './rng.js';

export type BrowserAction = Exclude<AgentAction, { type: 'finish' }>;

/** A step the persona injects after a planner action. */
export interface InjectedStep {
  behavior: BehaviorType;
  kind: StepKind;
  description: string;
  /** Browser actions executed in order within the step. */
  actions: BrowserAction[];
  /** For offline_blip: how long the network is cut. */
  offlineMs?: number;
}

const OFFLINE_BLIP_MS = 3000;
const STATEFUL: ReadonlySet<AgentAction['type']> = new Set(['click', 'fill', 'select', 'press']);

/**
 * Decides which behaviors fire after `action` succeeded. Each configured behavior rolls
 * its probability once, in spec order, from the run's behavior RNG, so the same seed and
 * the same sequence of actions give the same injections.
 */
export function planBehaviors(
  behaviors: readonly Behavior[],
  action: BrowserAction,
  rng: Rng,
): InjectedStep[] {
  const steps: InjectedStep[] = [];
  for (const b of behaviors) {
    if (!eligible(b.type, action)) continue;
    if (!rng.chance(b.probability)) continue;
    const reason = `[${b.type}] persona behavior`;
    switch (b.type) {
      case 'double_click':
        if (action.type === 'click') {
          steps.push({
            behavior: b.type,
            kind: 'CLICK',
            description: `Double-click: click ${action.ref} again immediately`,
            actions: [{ ...action, reason }],
          });
        }
        break;
      case 'rapid_repeat':
        if (action.type === 'click') {
          const extra = (b.repeat ?? 3) - 1;
          steps.push({
            behavior: b.type,
            kind: 'CLICK',
            description: `Rapid repeat: click ${action.ref} ${extra} more time(s)`,
            actions: Array.from({ length: extra }, () => ({ ...action, reason })),
          });
        }
        break;
      case 'refresh_mid_flow':
        steps.push({
          behavior: b.type,
          kind: 'RELOAD',
          description: 'Refresh the page mid-flow',
          actions: [{ type: 'reload', reason }],
        });
        break;
      case 'back_forward':
        steps.push({
          behavior: b.type,
          kind: 'GO_BACK',
          description: 'Press back, then forward',
          actions: [
            { type: 'goBack', reason },
            { type: 'goForward', reason },
          ],
        });
        break;
      case 'tab_hopping': {
        const count = b.repeat ?? 3;
        steps.push({
          behavior: b.type,
          kind: 'PRESS',
          description: `Tab through ${count} focusable element(s)`,
          actions: Array.from({ length: count }, () => ({
            type: 'press' as const,
            key: 'Tab',
            reason,
          })),
        });
        break;
      }
      case 'offline_blip':
        steps.push({
          behavior: b.type,
          kind: 'OFFLINE',
          description: `Lose the network for ${OFFLINE_BLIP_MS / 1000}s`,
          actions: [],
          offlineMs: OFFLINE_BLIP_MS,
        });
        break;
    }
  }
  return steps;
}

function eligible(type: BehaviorType, action: BrowserAction): boolean {
  switch (type) {
    case 'double_click':
    case 'rapid_repeat':
      return action.type === 'click';
    case 'back_forward':
      return action.type === 'click' || action.type === 'navigate';
    case 'refresh_mid_flow':
    case 'offline_blip':
      return STATEFUL.has(action.type);
    case 'tab_hopping':
      return true;
  }
}
