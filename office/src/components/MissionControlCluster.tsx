import { memo } from "react";
import { AgentAvatar } from "./AgentAvatar";
import type { AgentState } from "../lib/types";
import type { Team } from "./TeamPanel";
import { COLOR_MAP } from "./TeamPanel";

interface ClusterItem {
  session: { name: string; windows: string[] };
  agents: AgentState[];
  style: { accent: string; floor: string; wall: string; label: string };
  x: number;
  y: number;
}

interface MissionControlClusterProps {
  item: ClusterItem;
  hoveredAgent: string | null;
  setHoveredAgent: (v: string | null) => void;
  hoverPreview: unknown;
  showPreview: (agent: AgentState, room: { label: string; accent: string }, svgX: number, svgY: number) => void;
  hidePreview: () => void;
  onAgentClick: (agent: AgentState, svgX: number, svgY: number, room: { label: string; accent: string }) => void;
  teams?: Team[];
}

export const MissionControlCluster = memo(function MissionControlCluster({
  item: s,
  hoveredAgent,
  setHoveredAgent,
  hoverPreview,
  showPreview,
  hidePreview,
  onAgentClick,
  teams,
}: MissionControlClusterProps) {
  const agentCount = s.agents.length;
  const clusterRadius = Math.max(70, 35 + agentCount * 18);
  const hasBusy = s.agents.some((a) => a.status === "busy");

  return (
    <g>
      {/* Session zone */}
      <circle cx={s.x} cy={s.y} r={clusterRadius}
        fill={`${s.style.floor}cc`}
        stroke={s.style.accent}
        strokeWidth={hasBusy ? 1.5 : 0.5}
        opacity={hasBusy ? 0.8 : 0.4}
        style={hasBusy ? { animation: "room-pulse 2s ease-in-out infinite" } : {}}
      />

      {/* Session label */}
      <text
        x={s.x} y={s.y - clusterRadius - 12}
        textAnchor="middle"
        fill={s.style.accent}
        fontSize={13}
        fontWeight="bold"
        fontFamily="'SF Mono', monospace"
        letterSpacing={3}
        opacity={0.8}
      >
        {s.style.label.toUpperCase()}
      </text>

      {/* Agent count badge */}
      <text
        x={s.x} y={s.y + clusterRadius + 18}
        textAnchor="middle"
        fill={s.style.accent}
        fontSize={10}
        fontFamily="'SF Mono', monospace"
        opacity={0.6}
      >
        {agentCount} agent{agentCount !== 1 ? "s" : ""}
      </text>

      {/* Agents within cluster */}
      {s.agents.map((agent, ai) => {
        const agentAngle = (ai / Math.max(1, agentCount)) * Math.PI * 2 - Math.PI / 2;
        const agentRadius = agentCount === 1 ? 0 : Math.min(clusterRadius - 35, 35 + agentCount * 6);
        const ax = s.x + Math.cos(agentAngle) * agentRadius;
        const ay = s.y + Math.sin(agentAngle) * agentRadius;
        const isHovered = hoveredAgent === agent.target;
        const scale = isHovered ? 1.4 : 0.65;

        return (
          <g key={agent.target} transform={`translate(${ax}, ${ay})`}
            style={{ zIndex: isHovered ? 999 : 0 }}
          >
            {/* Hover backdrop glow */}
            {isHovered && (
              <circle cx={0} cy={-5} r={55} fill={s.style.accent} opacity={0.08} />
            )}
            <g
              transform={`scale(${scale})`}
              onMouseEnter={() => {
                setHoveredAgent(agent.target);
                showPreview(agent, { label: s.style.label, accent: s.style.accent }, ax, ay);
              }}
              onMouseLeave={() => {
                setHoveredAgent(null);
                hidePreview();
              }}
              style={{ transition: "transform 0.15s ease-out" }}
            >
              <AgentAvatar
                name={agent.name}
                target={agent.target}
                status={agent.status}
                preview={agent.preview}
                accent={s.style.accent}
                onClick={() => onAgentClick(agent, ax, ay, { label: s.style.label, accent: s.style.accent })}
              />
            </g>
            {/* Agent name (below) */}
            <text
              y={28}
              textAnchor="middle"
              fill={isHovered ? s.style.accent : "#ffffff"}
              fontSize={isHovered ? 11 : 9}
              fontFamily="'SF Mono', monospace"
              opacity={isHovered ? 1 : 0.7}
              style={{ transition: "all 0.2s", cursor: "pointer" }}
              onClick={() => onAgentClick(agent, ax, ay, { label: s.style.label, accent: s.style.accent })}
            >
              {agent.name.replace(/-oracle$/, "").replace(/-/g, " ")}
            </text>

            {/* Hover tooltip — hidden when preview card is showing */}
            {isHovered && !hoverPreview && (() => {
              const agentTeam = teams?.find(t => t.members.some(m =>
                m.name === agent.name || (agent.cwd && m.cwd && m.cwd === agent.cwd)
              ));
              const teamColor = agentTeam?.members[0]?.color ? COLOR_MAP[agentTeam.members[0].color] || s.style.accent : s.style.accent;
              const tooltipH = agentTeam ? 48 : 34;
              return (
                <g>
                  <rect x={-100} y={-65 - (agentTeam ? 14 : 0)} width={200} height={tooltipH} rx={8}
                    fill="rgba(8,8,16,0.95)" stroke={s.style.accent} strokeWidth={0.8} opacity={0.95} />
                  {agentTeam && (
                    <text x={0} y={-62} textAnchor="middle" fill={teamColor} fontSize={8}
                      fontFamily="'SF Mono', monospace" fontWeight="bold">
                      ● {agentTeam.name}
                    </text>
                  )}
                  {agent.preview && (
                    <text x={0} y={-48} textAnchor="middle" fill="#e0e0e0" fontSize={9}
                      fontFamily="'SF Mono', monospace">
                      {agent.preview.slice(0, 35)}
                    </text>
                  )}
                  <text x={0} y={-38} textAnchor="middle" fill={s.style.accent} fontSize={8}
                    fontFamily="'SF Mono', monospace" opacity={0.7}>
                    {agent.status} · {agent.target}
                  </text>
                </g>
              );
            })()}
          </g>
        );
      })}
    </g>
  );
});
