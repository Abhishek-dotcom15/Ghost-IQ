import { useEffect, useState } from 'react';
import type { Project } from '../App';
import { AlertOctagon, CheckCircle2, BarChart2 } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

// Dark reference palette: series blue, and the "critical" status red for slow endpoints.
const OK_COLOR = '#3987e5';
const SLOW_COLOR = '#d03b3b';

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

interface EndpointsViewProps {
  project: Project;
}

interface EndpointHealth {
  id: string;
  url: string;
  method: string;
  callCount: number;
  errorCount: number;
  avgLatencyMs: number;
  lastCalled: string;
}

export default function EndpointsView({ project }: EndpointsViewProps) {
  const [endpoints, setEndpoints] = useState<EndpointHealth[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEndpoints = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`);
      const data = await res.json();
      setEndpoints(data.endpoints || []);
    } catch (err) {
      console.error('Failed to load endpoint statistics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEndpoints();
  }, [project.id]);

  if (loading) {
    return (
      <div
        className="glass-card"
        style={{ display: 'flex', justifyContent: 'center', padding: '5rem' }}
      >
        <div className="pulse-running" style={{ width: '12px', height: '12px' }}></div>
        <span style={{ marginLeft: '1rem', color: 'hsl(var(--text-muted))' }}>
          Analyzing API endpoints logs...
        </span>
      </div>
    );
  }

  // Calculate high-risk API endpoints (e.g. slow response, or high error count)
  const highRisk = endpoints.filter((e) => e.errorCount > 0 || e.avgLatencyMs > 800);

  // Prepare chart data for API latencies
  const chartData = endpoints
    .map((e) => ({
      name: `${e.method} ${pathOf(e.url)}`,
      latency: Math.round(e.avgLatencyMs),
      errors: e.errorCount,
    }))
    .slice(0, 8); // Top 8 endpoints

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Top Overview Cards */}
      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <div className="glass-card" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div
            style={{
              background: 'rgba(17,185,129,0.1)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              color: 'hsl(var(--success))',
            }}
          >
            <CheckCircle2 size={24} />
          </div>
          <div>
            <span
              style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}
            >
              Operational API Endpoints
            </span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.5rem' }}>
              {endpoints.length - highRisk.length} / {endpoints.length}
            </span>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div
            style={{
              background: highRisk.length > 0 ? 'rgba(244,63,94,0.1)' : 'rgba(255,255,255,0.05)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              color: highRisk.length > 0 ? 'hsl(var(--danger))' : 'hsl(var(--text-muted))',
            }}
          >
            <AlertOctagon size={24} />
          </div>
          <div>
            <span
              style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}
            >
              Degraded / High Risk API Routes
            </span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.5rem' }}>
              {highRisk.length}
            </span>
          </div>
        </div>
      </section>

      {endpoints.length === 0 ? (
        <div
          className="glass-card"
          style={{ padding: '5rem', textShadow: 'center', color: 'hsl(var(--text-muted))' }}
        >
          No network logs registered yet. Run an autonomous test session from the dashboard to
          capture fetch/XHR API traffic maps.
        </div>
      ) : (
        <>
          {/* Latency Telemetry Chart */}
          <section
            className="glass-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <h3
              style={{
                fontFamily: 'var(--font-title)',
                fontSize: '1.2rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <BarChart2 size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> Average
              Response Latency (ms)
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))' }}>
              <span style={{ color: SLOW_COLOR }}>■</span> above 800 ms (slow) ·{' '}
              <span style={{ color: OK_COLOR }}>■</span> within budget
            </p>

            <div style={{ width: '100%', height: '280px', marginTop: '1rem' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="name" stroke="#898781" fontSize={11} tickLine={false} />
                  <YAxis stroke="#898781" fontSize={11} tickLine={false} unit="ms" />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--bg-secondary))',
                      borderColor: 'var(--border-glass)',
                      color: 'hsl(var(--text-primary))',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  />
                  {/* SVG fill attributes cannot resolve CSS var(): concrete colours only. */}
                  <Bar
                    dataKey="latency"
                    name="Average latency"
                    fill={OK_COLOR}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                    isAnimationActive={false}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.latency > 800 ? SLOW_COLOR : OK_COLOR}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* API Catalog Database Grid */}
          <section
            className="glass-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.2rem' }}>
              API Endpoint Diagnostics Inventory
            </h3>

            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                marginTop: '1rem',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--border-glass)',
                    color: 'hsl(var(--text-muted))',
                    fontSize: '0.85rem',
                  }}
                >
                  <th style={{ padding: '0.75rem 0.5rem' }}>Method</th>
                  <th>API Endpoint Endpoint</th>
                  <th>Total Hits</th>
                  <th>Errors</th>
                  <th>Avg Response Latency</th>
                  <th style={{ textAlign: 'right' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((ep) => {
                  const passRate =
                    ep.callCount > 0
                      ? Math.round(((ep.callCount - ep.errorCount) / ep.callCount) * 100)
                      : 100;
                  const isDegraded = passRate < 90 || ep.avgLatencyMs > 800;
                  return (
                    <tr
                      key={ep.id}
                      style={{ borderBottom: '1px solid var(--border-glass)', fontSize: '0.9rem' }}
                    >
                      <td style={{ padding: '1rem 0.5rem' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 700,
                            fontSize: '0.7rem',
                            padding: '0.2rem 0.4rem',
                            borderRadius: '4px',
                            backgroundColor:
                              ep.method === 'GET' ? 'rgba(14,165,233,0.1)' : 'rgba(139,92,246,0.1)',
                            color:
                              ep.method === 'GET'
                                ? 'hsl(var(--info))'
                                : 'hsl(var(--accent-purple))',
                          }}
                        >
                          {ep.method}
                        </span>
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          color: 'hsl(var(--text-primary))',
                        }}
                      >
                        {ep.url}
                      </td>
                      <td>{ep.callCount}</td>
                      <td style={{ color: ep.errorCount > 0 ? 'hsl(var(--danger))' : 'inherit' }}>
                        {ep.errorCount}
                      </td>
                      <td
                        style={{ color: ep.avgLatencyMs > 800 ? 'hsl(var(--danger))' : 'inherit' }}
                      >
                        {Math.round(ep.avgLatencyMs)} ms
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`badge ${isDegraded ? 'badge-danger' : 'badge-success'}`}>
                          {isDegraded ? 'DEGRADED' : 'HEALTHY'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
