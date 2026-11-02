import {
  PersonaSpec,
  RunConfig,
  type ElementLocator,
  type RunTestCommand,
  type StepCompletedEvent,
} from '@ghostiq/shared';
import type { Express } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import { approvedOverrides } from '../export/routes.js';
import { NotReplayableError, buildReplayScript, replayFlakiness } from './script.js';

export interface Dispatcher {
  /** Sends the command to the project's runner; false when no runner is online. */
  dispatch(projectId: string, command: RunTestCommand): boolean;
  online(projectId: string): boolean;
  notify(event: string, data: unknown): void;
}

export const MAX_REPLAYS = 10;
const ReplayBody = z.object({ runs: z.number().int().min(1).max(MAX_REPLAYS).default(1) });
const HealDecision = z.object({ status: z.enum(['approved', 'rejected']) });

interface Pending {
  projectId: string;
  command: RunTestCommand;
}

/**
 * Replays of a recorded run. A batch of N replays runs one at a time (concurrent replays
 * against the same app would interfere and look flaky); each finished replay starts the
 * next and updates the source run's flakiness.
 */
export class ReplayService {
  private readonly queues = new Map<string, Pending[]>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly dispatcher: Dispatcher,
  ) {}

  async start(sourceId: string, runs: number) {
    const source = await this.prisma.testSession.findUnique({
      where: { id: sourceId },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    if (!source) return { status: 404, error: 'Session not found' } as const;
    if (!this.dispatcher.online(source.projectId)) {
      return { status: 409, error: 'No runner agent is online for this project.' } as const;
    }
    if (this.queues.get(source.id)?.length) {
      return { status: 409, error: 'Replays of this run are already in progress.' } as const;
    }

    let script;
    try {
      script = buildReplayScript(
        source,
        source.steps,
        await approvedOverrides(this.prisma, source.id),
      );
    } catch (err) {
      if (err instanceof NotReplayableError) return { status: 400, error: err.message } as const;
      throw err;
    }
    const persona = PersonaSpec.parse(JSON.parse(source.personaJson ?? 'null'));
    const stored = RunConfig.parse(JSON.parse(source.configJson ?? 'null'));
    if (script.steps.length > 200) {
      return { status: 400, error: 'Runs longer than 200 actions cannot be replayed.' } as const;
    }
    const config: RunConfig = {
      ...stored,
      budgets: {
        ...stored.budgets,
        maxSteps: Math.max(stored.budgets.maxSteps, script.steps.length),
      },
    };

    const sessions = [];
    for (let i = 1; i <= runs; i++) {
      sessions.push(
        await this.prisma.testSession.create({
          data: {
            projectId: source.projectId,
            name: `Replay${runs > 1 ? ` ${i}/${runs}` : ''}: ${source.name}`.slice(0, 200),
            targetUrl: source.targetUrl,
            persona: source.persona,
            personaId: source.personaId,
            personaJson: source.personaJson,
            seed: source.seed,
            goal: source.goal,
            configJson: JSON.stringify(config),
            mode: 'replay',
            replayOfId: source.id,
            status: 'PENDING',
          },
        }),
      );
    }
    this.queues.set(
      source.id,
      sessions.map((s) => ({
        projectId: source.projectId,
        command: {
          sessionId: s.id,
          targetUrl: source.targetUrl,
          persona,
          seed: source.seed ?? persona.seed,
          goal: source.goal ?? source.name,
          config,
          replay: script,
        },
      })),
    );
    await this.dispatchNext(source.id);
    return { status: 201, sessions } as const;
  }

  /**
   * Before Phase 5, flakiness was computed across exploratory runs (model variance, not app
   * flakiness). Clears those scores on runs that have no replays behind them. Idempotent.
   */
  async resetLegacyFlakiness() {
    const sources = await this.prisma.testSession.findMany({
      where: { replayOfId: { not: null } },
      select: { replayOfId: true },
      distinct: ['replayOfId'],
    });
    const keep = sources.map((s) => s.replayOfId!);
    const { count } = await this.prisma.testSession.updateMany({
      where: { flakinessScore: { gt: 0 }, id: { notIn: keep } },
      data: { flakinessScore: 0 },
    });
    if (count) console.log(`[replay] cleared legacy flakiness scores on ${count} run(s)`);
  }

  /** Called for every finished session; only replays matter here. */
  async onSessionFinished(session: { id: string; mode: string; replayOfId: string | null }) {
    if (session.mode !== 'replay' || !session.replayOfId) return;
    const replays = await this.prisma.testSession.findMany({
      where: { replayOfId: session.replayOfId, status: { in: ['PASSED', 'FAILED'] } },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { status: true },
    });
    await this.prisma.testSession.update({
      where: { id: session.replayOfId },
      data: { flakinessScore: replayFlakiness(replays.map((r) => r.status)) },
    });
    await this.dispatchNext(session.replayOfId);
  }

  private async dispatchNext(sourceId: string) {
    const queue = this.queues.get(sourceId);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(sourceId);
      return;
    }
    await this.prisma.testSession.update({
      where: { id: next.command.sessionId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (!this.dispatcher.dispatch(next.projectId, next.command)) {
      // The runner went away: fail what is left of the batch rather than leave it pending.
      const ids = [next.command.sessionId, ...(queue ?? []).map((p) => p.command.sessionId)];
      this.queues.delete(sourceId);
      await this.prisma.testSession.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'FAILED',
          endReason: 'runner_disconnected',
          summary: 'No runner was online to execute this replay.',
          endedAt: new Date(),
        },
      });
    }
  }

  /** A healed step becomes a HealEvent for review (once per source step and new locator). */
  async recordHeal(
    session: { id: string; projectId: string; replayOfId: string | null },
    event: StepCompletedEvent,
    screenshotUrl: string | null,
  ) {
    if (!event.heal || !event.locator || !session.replayOfId) return;
    const newLocator: ElementLocator = event.locator;
    const sameTarget = (json: string) => {
      const l = JSON.parse(json) as ElementLocator;
      return l.role === newLocator.role && l.name === newLocator.name;
    };
    const earlier = await this.prisma.healEvent.findMany({
      where: { sourceSessionId: session.replayOfId, stepNumber: event.heal.sourceStep },
    });
    if (earlier.some((h) => sameTarget(h.newLocatorJson))) return;

    // Screenshots are taken after each action; the page the element was on is the one
    // captured by the step before (in the recording and in this replay).
    const [before, after] = await Promise.all([
      this.prisma.testStep.findFirst({
        where: { sessionId: session.replayOfId, stepNumber: { lt: event.heal.sourceStep } },
        orderBy: { stepNumber: 'desc' },
        select: { screenshotPath: true },
      }),
      this.prisma.testStep.findFirst({
        where: { sessionId: session.id, stepNumber: { lt: event.stepNumber } },
        orderBy: { stepNumber: 'desc' },
        select: { screenshotPath: true },
      }),
    ]);
    await this.prisma.healEvent.create({
      data: {
        projectId: session.projectId,
        sessionId: session.id,
        sourceSessionId: session.replayOfId,
        stepNumber: event.heal.sourceStep,
        oldLocatorJson: JSON.stringify(event.heal.from),
        newLocatorJson: JSON.stringify(newLocator),
        method: event.heal.method,
        confidence: event.heal.confidence,
        reason: event.heal.reason,
        beforeScreenshot: before?.screenshotPath ?? null,
        afterScreenshot: after?.screenshotPath ?? screenshotUrl,
      },
    });
    this.dispatcher.notify('heals-updated', { projectId: session.projectId });
  }
}

export function registerReplayRoutes(app: Express, prisma: PrismaClient, replays: ReplayService) {
  /** Replays a recorded run N times (no LLM unless a locator needs the model to heal). */
  app.post('/api/sessions/:id/replay', async (req, res) => {
    const body = ReplayBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: `runs must be between 1 and ${MAX_REPLAYS}` });
      return;
    }
    const result = await replays.start(req.params.id, body.data.runs);
    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ sessions: result.sessions });
  });

  /** A recorded run's replays and the flakiness they add up to. */
  app.get('/api/sessions/:id/replays', async (req, res) => {
    const source = await prisma.testSession.findUnique({ where: { id: req.params.id } });
    if (!source) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const list = await prisma.testSession.findMany({
      where: { replayOfId: source.id },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        status: true,
        endReason: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        steps: { where: { healed: true }, select: { stepNumber: true } },
      },
    });
    const decided = list.filter((r) => r.status === 'PASSED' || r.status === 'FAILED');
    res.json({
      flakinessScore: source.flakinessScore,
      passed: decided.filter((r) => r.status === 'PASSED').length,
      failed: decided.length - decided.filter((r) => r.status === 'PASSED').length,
      replays: list.map(({ steps, ...r }) => ({
        ...r,
        healedSteps: steps.map((s) => s.stepNumber),
      })),
    });
  });

  /** Heal review queue. */
  app.get('/api/projects/:id/heals', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const heals = await prisma.healEvent.findMany({
      where: { projectId: req.params.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const sources = await prisma.testSession.findMany({
      where: { id: { in: [...new Set(heals.map((h) => h.sourceSessionId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(sources.map((s) => [s.id, s.name]));
    res.json(
      heals.map((h) => ({
        ...h,
        sourceName: names.get(h.sourceSessionId) ?? null,
        oldLocator: JSON.parse(h.oldLocatorJson) as ElementLocator,
        newLocator: JSON.parse(h.newLocatorJson) as ElementLocator,
      })),
    );
  });

  /** Approve (exported tests and later replays use the new locator) or reject a heal. */
  app.post('/api/heals/:id/decision', async (req, res) => {
    const body = HealDecision.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'status must be "approved" or "rejected"' });
      return;
    }
    const heal = await prisma.healEvent.findUnique({ where: { id: req.params.id } });
    if (!heal) {
      res.status(404).json({ error: 'Heal not found' });
      return;
    }
    res.json(
      await prisma.healEvent.update({
        where: { id: heal.id },
        data: { status: body.data.status, decidedAt: new Date() },
      }),
    );
  });
}
