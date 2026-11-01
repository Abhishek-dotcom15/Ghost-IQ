import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { GeminiAIService } from './services/ai';

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // Allow up to 10MB file transmissions (screenshots)
});

const PORT = process.env.PORT || 3001;

// Ensure public directory for screenshots exists
const screenshotsDir = path.join(__dirname, '..', 'public', 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/screenshots', express.static(path.join(__dirname, '..', 'public', 'screenshots')));

// Map to store connected CLI agents: projectId -> Socket
const connectedAgents = new Map<string, Socket>();

// Socket.io connection coordinator
io.on('connection', (socket: Socket) => {
  const { role, projectId } = socket.handshake.query;
  console.log(`New WebSocket connection: role=${role}, projectId=${projectId}`);

  if (role === 'agent' && typeof projectId === 'string') {
    connectedAgents.set(projectId, socket);
    console.log(`CLI Agent connected for Project: ${projectId}`);
    io.emit('agent-status-change', { projectId, status: 'online' });

    socket.on('disconnect', () => {
      connectedAgents.delete(projectId);
      console.log(`CLI Agent disconnected for Project: ${projectId}`);
      io.emit('agent-status-change', { projectId, status: 'offline' });
    });

    // Handle incoming real-time telemetry from CLI agent
    socket.on('step-started', async (data: { sessionId: string; stepNumber: number; action: string; description: string }) => {
      console.log(`Step started: session=${data.sessionId}, step=${data.stepNumber}, action=${data.action}`);
      io.emit(`session-update:${data.sessionId}`, { type: 'step-started', data });
    });

    socket.on('step-completed', async (data: {
      sessionId: string;
      stepNumber: number;
      action: string;
      description: string;
      status: 'PASSED' | 'FAILED';
      error?: string;
      selector?: string;
      value?: string;
      screenshotBase64?: string;
      a11yViolations?: string;
      networkRequests: Array<{ url: string; method: string; status: number; latencyMs: number }>;
    }) => {
      console.log(`Step completed: session=${data.sessionId}, step=${data.stepNumber}, status=${data.status}`);

      let screenshotUrl: string | null = null;
      if (data.screenshotBase64) {
        try {
          const filename = `${data.sessionId}_${data.stepNumber}.png`;
          const filepath = path.join(screenshotsDir, filename);
          const buffer = Buffer.from(data.screenshotBase64, 'base64');
          fs.writeFileSync(filepath, buffer);
          screenshotUrl = `/screenshots/${filename}`;
        } catch (err) {
          console.error('Failed to save screenshot:', err);
        }
      }

      try {
        // Save test step to database
        const step = await prisma.testStep.create({
          data: {
            sessionId: data.sessionId,
            stepNumber: data.stepNumber,
            action: data.action,
            description: data.description,
            selector: data.selector,
            value: data.value,
            status: data.status,
            error: data.error,
            screenshotPath: screenshotUrl,
            a11yViolations: data.a11yViolations
          }
        });

        // Save network requests and update endpoint health telemetry
        const session = await prisma.testSession.findUnique({
          where: { id: data.sessionId }
        });

        if (session && data.networkRequests.length > 0) {
          for (const req of data.networkRequests) {
            await prisma.networkRequest.create({
              data: {
                stepId: step.id,
                url: req.url,
                method: req.method,
                status: req.status,
                latencyMs: req.latencyMs
              }
            });

            // Clean URL query parameters to group endpoints (e.g. /api/users?id=1 -> /api/users)
            let parsedUrl = req.url;
            try {
              const urlObj = new URL(req.url);
              parsedUrl = `${urlObj.origin}${urlObj.pathname}`;
            } catch (e) {
              // fallback if not absolute url
              parsedUrl = req.url.split('?')[0];
            }

            // Update running endpoint health stats
            const isError = req.status >= 400 || req.status === 0;
            const healthRecord = await prisma.endpointHealth.findUnique({
              where: {
                projectId_url_method: {
                  projectId: session.projectId,
                  url: parsedUrl,
                  method: req.method
                }
              }
            });

            if (healthRecord) {
              const newCount = healthRecord.callCount + 1;
              const newErrors = healthRecord.errorCount + (isError ? 1 : 0);
              const newAvgLatency = ((healthRecord.avgLatencyMs * healthRecord.callCount) + req.latencyMs) / newCount;

              await prisma.endpointHealth.update({
                where: { id: healthRecord.id },
                data: {
                  callCount: newCount,
                  errorCount: newErrors,
                  avgLatencyMs: newAvgLatency,
                  lastCalled: new Date()
                }
              });
            } else {
              await prisma.endpointHealth.create({
                data: {
                  projectId: session.projectId,
                  url: parsedUrl,
                  method: req.method,
                  callCount: 1,
                  errorCount: isError ? 1 : 0,
                  avgLatencyMs: req.latencyMs,
                  lastCalled: new Date()
                }
              });
            }
          }
        }

        // Stream completed step details back to dashboard clients
        io.emit(`session-update:${data.sessionId}`, {
          type: 'step-completed',
          data: {
            ...step,
            networkLogs: data.networkRequests
          }
        });
      } catch (err) {
        console.error('Error saving step to database:', err);
      }
    });

    socket.on('session-completed', async (data: { sessionId: string; status: 'PASSED' | 'FAILED' }) => {
      console.log(`Session finished: ${data.sessionId} - Status: ${data.status}`);
      try {
        await prisma.testSession.update({
          where: { id: data.sessionId },
          data: {
            status: data.status,
            endedAt: new Date()
          }
        });

        // Calculate and update flakiness score
        const session = await prisma.testSession.findUnique({
          where: { id: data.sessionId }
        });
        if (session) {
          const sisterSessions = await prisma.testSession.findMany({
            where: {
              projectId: session.projectId,
              targetUrl: session.targetUrl,
              persona: session.persona,
              status: { in: ['PASSED', 'FAILED'] }
            },
            orderBy: { startedAt: 'asc' }
          });

          // calculate status transitions (passed <-> failed)
          let statusShifts = 0;
          for (let i = 1; i < sisterSessions.length; i++) {
            if (sisterSessions[i].status !== sisterSessions[i - 1].status) {
              statusShifts++;
            }
          }
          const flakinessScore = sisterSessions.length > 0 ? (statusShifts / sisterSessions.length) * 100 : 0.0;

          await prisma.testSession.update({
            where: { id: data.sessionId },
            data: { flakinessScore }
          });
        }

        // Trigger AI Bug diagnostics summary if the test run failed
        if (data.status === 'FAILED') {
          triggerAiDiagnostics(data.sessionId);
        }

        io.emit(`session-update:${data.sessionId}`, { type: 'session-completed', data });
      } catch (err) {
        console.error('Error completing session in DB:', err);
      }
    });
  } else if (role === 'dashboard') {
    console.log('Dashboard client connected');
  }
});

// AI Bug Diagnostics Helper
async function triggerAiDiagnostics(sessionId: string) {
  try {
    const session = await prisma.testSession.findUnique({
      where: { id: sessionId },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: { networkLogs: true }
        }
      }
    });

    if (!session) return;

    console.log(`Running Gemini AI Bug Diagnostics for failed session: ${sessionId}`);
    const diagnostics = await GeminiAIService.generateDiagnosticsReport(session);

    io.emit(`session-update:${sessionId}`, {
      type: 'diagnostics-ready',
      data: { diagnostics }
    });
  } catch (err) {
    console.error('AI Diagnostics failure:', err);
  }
}

// REST APIs
// 1. Projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      include: {
        sessions: {
          orderBy: { startedAt: 'desc' },
          take: 5
        },
        _count: {
          select: { sessions: true, endpoints: true }
        }
      }
    });

    // Map projects and add running online status
    const projectsWithStatus = projects.map(p => ({
      ...p,
      agentOnline: connectedAgents.has(p.id)
    }));

    res.json(projectsWithStatus);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.post('/api/projects', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  try {
    const project = await prisma.project.create({
      data: { name }
    });
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        sessions: {
          orderBy: { startedAt: 'desc' }
        },
        endpoints: {
          orderBy: { avgLatencyMs: 'desc' }
        }
      }
    });

    if (!project) return res.status(404).json({ error: 'Project not found' });

    res.json({
      ...project,
      agentOnline: connectedAgents.has(project.id)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// 2. Test Sessions
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await prisma.testSession.findUnique({
      where: { id: req.params.id },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: { networkLogs: true }
        }
      }
    });

    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

app.post('/api/sessions', async (req, res) => {
  const { projectId, targetUrl, persona, goal } = req.body;
  if (!projectId || !targetUrl || !persona) {
    return res.status(400).json({ error: 'projectId, targetUrl, and persona are required' });
  }

  try {
    const agentSocket = connectedAgents.get(projectId);
    if (!agentSocket) {
      return res.status(400).json({ error: 'No CLI agent is currently online for this project. Please run npx ghostiq-agent first.' });
    }

    // Create session in DB
    const sessionName = `Run: ${persona} - ${new Date().toLocaleTimeString()}`;
    const session = await prisma.testSession.create({
      data: {
        projectId,
        name: sessionName,
        targetUrl,
        persona,
        status: 'PENDING'
      }
    });

    // Notify connected CLI Agent to start execution
    agentSocket.emit('run-test', {
      sessionId: session.id,
      targetUrl,
      persona,
      goal: goal || `Explore the page and verify critical actions like login, nav, and inputs.`
    });

    // Update session status to running
    await prisma.testSession.update({
      where: { id: session.id },
      data: { status: 'RUNNING' }
    });

    res.status(201).json(session);
  } catch (err) {
    console.error('Failed to launch session:', err);
    res.status(500).json({ error: 'Failed to trigger test session' });
  }
});

// AI DOM parsing agent planner (invoked by CLI Agent)
app.post('/api/ai/plan-step', async (req, res) => {
  const { sessionId, htmlSnapshot, currentUrl, history, goal, persona } = req.body;
  
  try {
    console.log(`AI planning next step for session: ${sessionId} at url: ${currentUrl}`);
    const nextAction = await GeminiAIService.planNextAction(
      htmlSnapshot,
      currentUrl,
      history || [],
      goal,
      persona
    );
    res.json(nextAction);
  } catch (err) {
    console.error('AI Planning error:', err);
    res.status(500).json({ error: 'AI planning engine failed' });
  }
});

// AI DOM parsing selector healer
app.post('/api/ai/heal-selector', async (req, res) => {
  const { failedSelector, htmlSnapshot, goal, persona } = req.body;
  
  try {
    console.log(`AI healing failed selector: ${failedSelector}`);
    const healed = await GeminiAIService.healSelector(
      failedSelector,
      htmlSnapshot,
      goal,
      persona
    );
    res.json(healed);
  } catch (err) {
    console.error('Selector healing error:', err);
    res.status(500).json({ error: 'AI healing engine failed' });
  }
});

// Set session as Baseline
app.post('/api/sessions/:id/set-baseline', async (req, res) => {
  try {
    const session = await prisma.testSession.findUnique({
      where: { id: req.params.id }
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Reset other baselines for this configuration
    await prisma.testSession.updateMany({
      where: {
        projectId: session.projectId,
        targetUrl: session.targetUrl,
        persona: session.persona
      },
      data: { isBaseline: false }
    });

    // Mark this session as baseline
    const updated = await prisma.testSession.update({
      where: { id: req.params.id },
      data: { isBaseline: true }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set baseline' });
  }
});

// Get baseline session for visual regression diff
app.get('/api/projects/:id/baseline', async (req, res) => {
  const { targetUrl, persona } = req.query;
  if (!targetUrl || !persona) {
    return res.status(400).json({ error: 'targetUrl and persona are required' });
  }

  try {
    const baseline = await prisma.testSession.findFirst({
      where: {
        projectId: req.params.id,
        targetUrl: targetUrl as string,
        persona: persona as string,
        isBaseline: true
      },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' }
        }
      }
    });
    res.json(baseline);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch baseline session' });
  }
});

// Export report to GitHub mock pull request check
app.post('/api/projects/:id/export-pr', async (req, res) => {
  const { repo, prNumber } = req.body;
  if (!repo || !prNumber) {
    return res.status(400).json({ error: 'repo and prNumber are required' });
  }

  try {
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        githubRepo: repo,
        githubPrNumber: parseInt(prNumber)
      }
    });

    // Get latest session details
    const latestSession = await prisma.testSession.findFirst({
      where: { projectId: req.params.id },
      orderBy: { startedAt: 'desc' },
      include: { steps: true }
    });

    const statusSymbol = latestSession?.status === 'PASSED' ? '✅' : '❌';
    const mockComment = `
### 👻 GhostIQ Autonomous Test Report

**Repo**: \`${repo}\` | **PR**: \`#${prNumber}\`
**Status**: ${statusSymbol} **${latestSession?.status || 'UNKNOWN'}**
**Target URL**: \`${latestSession?.targetUrl || 'N/A'}\`
**Persona**: \`${latestSession?.persona || 'N/A'}\`

#### Summary of Test Run:
${latestSession?.steps.map(s => `- Step ${s.stepNumber} [${s.status}]: ${s.description}`).join('\n') || 'No steps executed.'}

${latestSession?.status === 'FAILED' ? `> 🚨 **AI Bug Diagnostics**: Triggered diagnostics trace check in dashboard.` : ''}
`;

    res.json({
      success: true,
      comment: mockComment.trim(),
      project
    });
  } catch (err) {
    console.error('Failed to export PR check:', err);
    res.status(500).json({ error: 'Failed to export PR comments' });
  }
});

// Server boot
server.listen(PORT, () => {
  console.log(`GhostIQ Central Server listening on port ${PORT}`);
});
