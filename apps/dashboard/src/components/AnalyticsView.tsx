import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Socket } from 'socket.io-client';
import type { Project } from '../App';
import { fetchAnalytics, pct, usd, type Analytics } from '../lib/analytics';
import { SEVERITY_ORDER, SEVERITY_STYLE } from '../lib/findings';

interface AnalyticsViewProps {
  project: Project;
  socket: Socket;
  onReviewHeals: () => void;
}

// Chart chrome (dark reference palette): recessive grid and axes, one series hue.
const INK = { primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781' };
const GRID = 'rgba(255,255,255,0.06)';
const SERIES_1 = '#3987e5';
const SURFACE = '#17161f';

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const title = {
  fontFamily: 'var(--font-title)',
  fontSize: '1rem',
  marginBottom: '0.25rem',
} as const;
const th = { textAlign: 'left', padding: '0.4rem 0.6rem', ...muted, fontWeight: 600 } as const;
const td = {
  padding: '0.45rem 0.6rem',
  fontSize: '0.85rem',
  borderTop: '1px solid var(--border-glass)',
} as const;
const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

const tooltipStyle = {
  contentStyle: {
    background: SURFACE,
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: INK.primary,
    fontSize: 12,
  },
  labelStyle: { color: INK.secondary },
  cursor: { fill: 'rgba(255,255,255,0.04)' },
};

const RANGES = [7, 30, 90];

/** Coverage, persona effectiveness, findings over time, cost per finding, endpoint latency. */
export default function AnalyticsView({ project, socket, onReviewHeals }: AnalyticsViewProps) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchAnalytics(project.id, days));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project.id, days]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUpdate = (e: { projectId: string }) => {
      if (e.projectId === project.id) void load();
    };
    socket.on('findings-updated', onUpdate);
    socket.on('heals-updated', onUpdate);
    return () => {
      socket.off('findings-updated', onUpdate);
      socket.off('heals-updated', onUpdate);
    };
  }, [socket, project.id, load]);

  if (error)
    return (
      <div className="glass-card" style={{ color: 'hsl(var(--danger))' }}>
        {error}
      </div>
    );
  if (!data)
    return (
      <div className="glass-card" style={muted}>
        Loading analytics...
      </div>
    );

  const t = data.totals;
  const personas = [...new Set(data.coverage.nodes.flatMap((n) => n.personas))].sort();
  const endpoints = data.endpoints.filter((e) => e.p95 !== null).slice(0, 10);
  const shortDay = (d: string) => d.slice(5);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Range filter: one row, above everything it controls */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <span style={muted}>Range</span>
        {RANGES.map((r) => (
          <button
            key={r}
            className={`btn ${days === r ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }}
            onClick={() => setDays(r)}
            aria-pressed={days === r}
          >
            Last {r} days
          </button>
        ))}
      </div>

      {/* Headline numbers */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '0.75rem',
        }}
      >
        <Stat label="Exploratory runs" value={String(t.runs)} />
        <Stat label="Routes covered" value={String(t.routes)} />
        <Stat
          label="New findings"
          value={String(t.findings)}
          sub={`${t.openFindings} still open`}
        />
        <Stat label="LLM spend" value={usd(t.costUsd)} />
        <Stat label="Cost per finding" value={usd(t.costPerFinding)} />
        <Stat
          label="Replay pass rate"
          value={pct(t.replayPassRate)}
          sub={`${t.replays} replay${t.replays === 1 ? '' : 's'}`}
        />
      </div>

      {/* Findings over time */}
      <div className="glass-card" style={{ padding: '1rem' }}>
        <h3 style={title}>New findings per day</h3>
        <p style={muted}>By severity, counted on the day a finding was first seen.</p>
        <div style={{ height: 240, marginTop: '0.75rem' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.timeline} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={shortDay}
                tick={{ fill: INK.muted, fontSize: 11 }}
                axisLine={{ stroke: '#383835' }}
                tickLine={false}
                minTickGap={16}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: INK.muted, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip {...tooltipStyle} />
              <Legend
                wrapperStyle={{ fontSize: 12, color: INK.secondary }}
                iconType="circle"
                iconSize={8}
                itemSorter={(item) =>
                  SEVERITY_ORDER.indexOf(item.dataKey as (typeof SEVERITY_ORDER)[number])
                }
              />
              {[...SEVERITY_ORDER].reverse().map((s) => (
                <Bar
                  key={s}
                  dataKey={s}
                  name={SEVERITY_STYLE[s].label}
                  stackId="sev"
                  fill={SEVERITY_STYLE[s].color}
                  stroke={SURFACE}
                  strokeWidth={2}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Persona effectiveness */}
      <div className="glass-card" style={{ padding: '1rem', overflowX: 'auto' }}>
        <h3 style={title}>Persona effectiveness</h3>
        <p style={muted}>
          Which personas find bugs, how much of the app they reach, and what each finding costs.
        </p>
        {data.personas.length === 0 ? (
          <p style={{ ...muted, marginTop: '0.75rem' }}>No exploratory runs in this range.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.75rem' }}>
            <thead>
              <tr>
                <th style={th}>Persona</th>
                <th style={{ ...th, textAlign: 'right' }}>Runs</th>
                <th style={{ ...th, textAlign: 'right' }}>Goal met</th>
                <th style={th}>Route coverage</th>
                <th style={{ ...th, textAlign: 'right' }}>Findings</th>
                <th style={{ ...th, textAlign: 'right' }}>LLM cost</th>
                <th style={{ ...th, textAlign: 'right' }}>Cost / finding</th>
              </tr>
            </thead>
            <tbody>
              {data.personas.map((p) => (
                <tr key={p.persona}>
                  <td style={td}>{p.persona}</td>
                  <td style={num}>{p.runs}</td>
                  <td style={num}>
                    {p.goalMet}/{p.runs}
                  </td>
                  <td style={td}>
                    <Meter value={p.coverage} label={`${p.routes} of ${t.routes} routes`} />
                  </td>
                  <td style={num}>{p.findings}</td>
                  <td style={num}>{usd(p.costUsd)}</td>
                  <td style={num}>{usd(p.costPerFinding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: '1.25rem',
        }}
      >
        {/* Coverage map */}
        <div className="glass-card" style={{ padding: '1rem', overflowX: 'auto' }}>
          <h3 style={title}>Coverage map</h3>
          <p style={muted}>
            Routes reached, and by which persona. Gaps are parts of the app no persona tested.
          </p>
          {data.coverage.nodes.length === 0 ? (
            <p style={{ ...muted, marginTop: '0.75rem' }}>No pages visited yet.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', marginTop: '0.75rem', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>Route</th>
                  <th style={{ ...th, textAlign: 'right' }}>Visits</th>
                  {personas.map((p) => (
                    <th key={p} style={{ ...th, textAlign: 'center', maxWidth: 70 }} title={p}>
                      {initials(p)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.coverage.nodes.slice(0, 30).map((n) => (
                  <tr key={n.route}>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                      {n.route}
                    </td>
                    <td style={num}>{n.visits}</td>
                    {personas.map((p) => {
                      const hit = n.personas.includes(p);
                      return (
                        <td
                          key={p}
                          style={{ ...td, textAlign: 'center' }}
                          title={`${p}: ${hit ? 'visited' : 'not visited'} ${n.route}`}
                        >
                          <span
                            aria-label={hit ? 'visited' : 'not visited'}
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: hit ? SERIES_1 : 'transparent',
                              border: hit ? 'none' : `1px solid ${INK.muted}`,
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {personas.length > 0 && (
            <p style={{ ...muted, fontSize: '0.72rem', marginTop: '0.5rem' }}>
              {personas.map((p) => `${initials(p)} = ${p}`).join(' · ')}
            </p>
          )}
          {data.coverage.edges.length > 0 && (
            <>
              <h4 style={{ ...title, fontSize: '0.85rem', marginTop: '1rem' }}>
                Most travelled paths
              </h4>
              <ul
                style={{
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                {data.coverage.edges.slice(0, 8).map((e) => (
                  <li
                    key={`${e.from}>${e.to}`}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}
                  >
                    {e.from} <span style={muted}>→</span> {e.to}{' '}
                    <span style={muted}>×{e.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Endpoint latency */}
        <div className="glass-card" style={{ padding: '1rem' }}>
          <h3 style={title}>Slowest endpoints (p95 latency)</h3>
          <p style={muted}>Hover a bar for p50, call count and error rate.</p>
          {endpoints.length === 0 ? (
            <p style={{ ...muted, marginTop: '0.75rem' }}>No API traffic recorded.</p>
          ) : (
            <div style={{ height: Math.max(160, endpoints.length * 34), marginTop: '0.75rem' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={endpoints.map((e) => ({ ...e, label: `${e.method} ${e.route}` }))}
                  margin={{ top: 0, right: 40, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis
                    type="number"
                    unit=" ms"
                    tick={{ fill: INK.muted, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={170}
                    tick={{ fill: INK.secondary, fontSize: 11 }}
                    axisLine={{ stroke: '#383835' }}
                    tickLine={false}
                  />
                  <Tooltip
                    {...tooltipStyle}
                    content={({ active, payload }) => {
                      const e = active && payload?.[0]?.payload;
                      if (!e) return null;
                      return (
                        <div style={{ ...tooltipStyle.contentStyle, padding: '0.5rem 0.65rem' }}>
                          <div style={{ fontWeight: 600 }}>{e.label}</div>
                          <div>
                            p95 {e.p95} ms · p50 {e.p50} ms
                          </div>
                          <div style={{ color: INK.secondary }}>
                            {e.calls} call(s) · {pct(e.errorRate)} errors
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="p95"
                    name="p95 latency"
                    fill={SERIES_1}
                    radius={[0, 4, 4, 0]}
                    maxBarSize={18}
                    isAnimationActive={false}
                    label={{ position: 'right', fill: INK.secondary, fontSize: 11 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Replays & heals */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '1.25rem',
        }}
      >
        <div className="glass-card" style={{ padding: '1rem' }}>
          <h3 style={title}>Locator heals</h3>
          <p style={muted}>
            Elements found by similar name or by the model during replay. Reviewed heals feed the
            false-heal rate.
          </p>
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <Figure label="Awaiting review" value={String(data.heals.pending)} />
            <Figure label="Approved" value={String(data.heals.approved)} />
            <Figure label="Rejected" value={String(data.heals.rejected)} />
            <Figure label="False-heal rate" value={pct(data.heals.falseHealRate)} />
          </div>
          {data.heals.pending > 0 && (
            <button
              className="btn btn-primary"
              style={{ marginTop: '0.9rem', fontSize: '0.8rem' }}
              onClick={onReviewHeals}
            >
              Review {data.heals.pending} heal{data.heals.pending === 1 ? '' : 's'}
            </button>
          )}
        </div>
        <div className="glass-card" style={{ padding: '1rem' }}>
          <h3 style={title}>Flaky flows</h3>
          <p style={muted}>
            Measured on deterministic replays: 0% = every replay agrees, 100% = a 50/50 split.
          </p>
          {data.flaky.length === 0 ? (
            <p style={{ ...muted, marginTop: '0.75rem' }}>
              No flaky flows. Replay a recorded run a few times from Test Sessions to measure it.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                marginTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem',
              }}
            >
              {data.flaky.map((f) => (
                <li
                  key={f.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <span>{f.name}</span>
                  <span className="badge badge-warning">{Math.round(f.flakinessScore)}% flaky</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass-card" style={{ padding: '0.85rem 1rem' }}>
      <div style={muted}>{label}</div>
      <div style={{ fontFamily: 'var(--font-title)', fontSize: '1.6rem', fontWeight: 700 }}>
        {value}
      </div>
      {sub && <div style={{ ...muted, fontSize: '0.72rem' }}>{sub}</div>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-title)', fontSize: '1.3rem', fontWeight: 700 }}>
        {value}
      </div>
      <div style={muted}>{label}</div>
    </div>
  );
}

/** Thin horizontal meter with its value written beside it (never colour alone). */
function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} title={label}>
      <div style={{ width: 90, height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.08)' }}>
        <div
          style={{
            width: `${Math.round(value * 100)}%`,
            height: '100%',
            borderRadius: 4,
            background: SERIES_1,
          }}
        />
      </div>
      <span style={{ fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>{pct(value)}</span>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}
