import { memo, useMemo, useState, useCallback, useRef, useEffect } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { HoverPreviewCard } from "./HoverPreviewCard";
import { Joystick } from "./Joystick";
import { OracleSearch } from "./OracleSearch";
import { roomStyle, agentColor } from "../lib/constants";
import type { AgentState, Session, AgentEvent } from "../lib/types";

interface MissionControlProps {
  sessions: Session[];
  agents: AgentState[];
  saiyanTargets: Set<string>;
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  addEvent: (target: string, type: AgentEvent["type"], detail: string) => void;
}

export const MissionControl = memo(function MissionControl({
  sessions,
  agents,
  saiyanTargets,
  connected,
  send,
  onSelectAgent,
  eventLog,
  addEvent,
}: MissionControlProps) {
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ agent: AgentState; room: { label: string; accent: string }; pos: { x: number; y: number } } | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<{ agent: AgentState; room: { label: string; accent: string }; pos: { x: number; y: number }; svgX: number; svgY: number } | null>(null);
  const pinnedByUser = useRef(false); // true = user clicked, false = auto-pinned by saiyan
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>();

  // Auto-popup cards for Saiyan agents — max 3 visible, 2s stagger, FIFO
  type SaiyanCard = { agent: AgentState; room: { label: string; accent: string }; svgX: number; svgY: number; order: number };
  const [saiyanCards, setSaiyanCards] = useState<Map<string, SaiyanCard>>(new Map());
  const saiyanQueue = useRef<string[]>([]); // pending targets waiting to appear
  const saiyanStaggerTimer = useRef<ReturnType<typeof setTimeout>>();
  const saiyanDismissTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saiyanOrderCounter = useRef(0);
  const prevSaiyanTargets = useRef<Set<string>>(new Set());

  const [showSearch, setShowSearch] = useState(false);

  // Hide search when card is pinned
  useEffect(() => {
    if (pinnedPreview) setShowSearch(false);
  }, [pinnedPreview]);

  // Cmd+K or Ctrl+K to toggle search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch((s) => !s);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const [zoom, setZoom] = useState(1.1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Convert SVG coordinates to screen-relative position
  const svgToScreen = useCallback((svgX: number, svgY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const screenPt = pt.matrixTransform(ctm);
    const containerRect = container.getBoundingClientRect();
    return {
      x: screenPt.x - containerRect.left,
      y: screenPt.y - containerRect.top,
    };
  }, []);

  // side: "right" (default/hover), "left", or "auto" (prefer right, fallback left)
  const calcCardPos = useCallback((svgX: number, svgY: number, side: "left" | "right" | "auto" = "auto") => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return { x: 0, y: 0 };
    const screen = svgToScreen(svgX, svgY);
    const cardW = 420;
    const cardH = 500;
    const rightX = screen.x + 60;
    const leftX = screen.x - cardW - 40;
    let x: number;
    if (side === "right") {
      x = rightX + cardW > containerRect.width ? leftX : rightX;
    } else if (side === "left") {
      x = leftX < 0 ? rightX : leftX;
    } else {
      x = rightX + cardW > containerRect.width ? leftX : rightX;
    }
    const y = Math.max(10, Math.min(screen.y - 290, containerRect.height - cardH - 20));
    return { x, y };
  }, [svgToScreen]);

  // Show preview card on hover — anchored to agent's SVG position (skip when pinned)
  const showPreview = useCallback((agent: AgentState, room: { label: string; accent: string }, svgX: number, svgY: number) => {
    if (pinnedPreview) return; // don't show hover when a card is pinned
    clearTimeout(hoverTimeout.current);
    const pos = calcCardPos(svgX, svgY);
    setHoverPreview({ agent, room, pos });
  }, [calcCardPos, pinnedPreview]);

  const hidePreview = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverPreview(null), 300);
  }, []);

  const keepPreview = useCallback(() => {
    clearTimeout(hoverTimeout.current);
  }, []);

  const busyCount = agents.filter((a) => a.status === "busy").length;
  const readyCount = agents.filter((a) => a.status === "ready").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;

  // Disable mouse wheel zoom entirely — use +/- buttons instead

  // Pan with middle mouse or drag
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 0 && e.shiftKey) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    }
  }, [pan]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panStart.current.panX + dx / zoom, y: panStart.current.panY + dy / zoom });
  }, [isPanning, zoom]);

  const onMouseUp = useCallback(() => setIsPanning(false), []);

  const resetView = useCallback(() => { setZoom(1.1); setPan({ x: 0, y: 0 }); }, []);

  const onJoystickPan = useCallback((dx: number, dy: number) => {
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  // Group agents by session
  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    return map;
  }, [agents]);

  // Layout: arrange sessions in a hex-ish grid
  // Each session is a cluster of agents
  const layout = useMemo(() => {
    const sessionList = sessions.map((s) => ({
      session: s,
      agents: sessionAgents.get(s.name) || [],
      style: roomStyle(s.name),
    }));

    // Calculate positions in a radial layout — fill the viewport
    const cx = 600, cy = 500;
    const radius = Math.min(320, 160 + sessionList.length * 22);

    return sessionList.map((s, i) => {
      const angle = (i / sessionList.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      return { ...s, x, y };
    });
  }, [sessions, sessionAgents]);

  // Persistent input buffer per agent (survives pin/unpin)
  const [inputBufs, setInputBufs] = useState<Record<string, string>>({});
  const getInputBuf = useCallback((target: string) => inputBufs[target] || "", [inputBufs]);
  const setInputBuf = useCallback((target: string, val: string) => {
    setInputBufs(prev => ({ ...prev, [target]: val }));
  }, []);

  // Click agent → pin preview card (not fullscreen modal)
  // If already pinned, just log event + sound — don't open another popup
  const onAgentClick = useCallback(
    (agent: AgentState, svgX: number, svgY: number, room: { label: string; accent: string }) => {
      if (pinnedPreview) {
        // Already have a pinned card — just add event badge, no new popup
        addEvent(agent.target, "command", `clicked ${agent.name}`);
        return;
      }
      const pos = calcCardPos(svgX, svgY);
      pinnedByUser.current = true;
      setPinnedPreview({ agent, room, pos, svgX, svgY });
      setHoverPreview(null); // hide hover
      send({ type: "subscribe", target: agent.target });
    },
    [calcCardPos, send, pinnedPreview, addEvent]
  );

  // Fullscreen → close pin first, then open modal (so focus transfers cleanly)
  const onPinnedFullscreen = useCallback(() => {
    if (pinnedPreview) {
      const agent = pinnedPreview.agent;
      setPinnedPreview(null);
      setTimeout(() => onSelectAgent(agent), 150);
    }
  }, [pinnedPreview, onSelectAgent]);

  const onPinnedClose = useCallback(() => {
    setPinnedPreview(null);
  }, []);

  const pinnedRef = useRef<HTMLDivElement>(null);

  // Animate pinned card from hover position to center
  const [pinnedAnimPos, setPinnedAnimPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (pinnedPreview) {
      // Start at hover position
      setPinnedAnimPos({ left: pinnedPreview.pos.x, top: pinnedPreview.pos.y });
      // Transition to center on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const containerW = containerRef.current?.getBoundingClientRect().width || 800;
          setPinnedAnimPos({ left: (containerW - 420) / 2, top: 20 });
        });
      });
    } else {
      setPinnedAnimPos(null);
    }
  }, [pinnedPreview]);

  // Click outside pinned card to close
  useEffect(() => {
    if (!pinnedPreview) return;
    const handler = (e: MouseEvent) => {
      if (pinnedRef.current && !pinnedRef.current.contains(e.target as Node)) {
        setPinnedPreview(null);
      }
    };
    // Delay to avoid the same click that pinned it from closing it
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handler); };
  }, [pinnedPreview]);

  // Build lookup: agent target -> { svgX, svgY, room style }
  const agentPositions = useMemo(() => {
    const map = new Map<string, { svgX: number; svgY: number; style: ReturnType<typeof roomStyle> }>();
    for (const s of layout) {
      const count = s.agents.length;
      s.agents.forEach((agent, ai) => {
        const angle = (ai / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
        const r = count === 1 ? 0 : Math.min(Math.max(70, 35 + count * 18) - 35, 35 + count * 6);
        map.set(agent.target, {
          svgX: s.x + Math.cos(angle) * r,
          svgY: s.y + Math.sin(angle) * r,
          style: s.style,
        });
      });
    }
    return map;
  }, [layout]);

  // Auto-pin saiyan agents: cycle if auto-pinned, skip if user-pinned
  useEffect(() => {
    if (saiyanTargets.size === 0 || agentPositions.size === 0) return;
    // If user manually pinned, don't override
    if (pinnedPreview && pinnedByUser.current) return;
    // Find a saiyan target that isn't already shown
    const currentTarget = pinnedPreview?.agent.target;
    const targets = [...saiyanTargets];
    const nextTarget = targets.find(t => t !== currentTarget) || targets[0];
    if (nextTarget === currentTarget) return; // already showing this one
    const agent = agents.find(a => a.target === nextTarget);
    const pos = agentPositions.get(nextTarget);
    if (agent && pos) {
      const cardPos = calcCardPos(pos.svgX, pos.svgY);
      pinnedByUser.current = false;
      setPinnedPreview({ agent, room: { label: pos.style.label, accent: pos.style.accent }, pos: cardPos, svgX: pos.svgX, svgY: pos.svgY });
      setHoverPreview(null);
      send({ type: "subscribe", target: nextTarget });
    }
  }, [saiyanTargets, agentPositions]);

  // Process queue: show next card from queue (max 3 visible, 2s stagger)
  const processQueue = useCallback(() => {
    clearTimeout(saiyanStaggerTimer.current);
    const showNext = () => {
      if (saiyanQueue.current.length === 0) return;
      const target = saiyanQueue.current.shift()!;
      const agent = agents.find(a => a.target === target);
      const pos = agentPositions.get(target);
      if (!agent || !pos) { showNext(); return; } // skip invalid, try next

      saiyanOrderCounter.current++;
      const card: SaiyanCard = {
        agent,
        room: { label: pos.style.label, accent: pos.style.accent },
        svgX: pos.svgX,
        svgY: pos.svgY,
        order: saiyanOrderCounter.current,
      };

      setSaiyanCards(prev => {
        const next = new Map(prev);
        // If already at 3, remove the oldest (lowest order)
        if (next.size >= 3) {
          let oldestKey = "";
          let oldestOrder = Infinity;
          for (const [k, v] of next) {
            if (v.order < oldestOrder) { oldestOrder = v.order; oldestKey = k; }
          }
          if (oldestKey) {
            next.delete(oldestKey);
            clearTimeout(saiyanDismissTimers.current[oldestKey]);
          }
        }
        next.set(target, card);
        return next;
      });

      // Auto-dismiss after 10s
      clearTimeout(saiyanDismissTimers.current[target]);
      saiyanDismissTimers.current[target] = setTimeout(() => {
        setSaiyanCards(prev => {
          const next = new Map(prev);
          next.delete(target);
          return next;
        });
      }, 10000);

      // Schedule next card with 2s stagger
      if (saiyanQueue.current.length > 0) {
        saiyanStaggerTimer.current = setTimeout(showNext, 2000);
      }
    };
    showNext();
  }, [agents, agentPositions]);

  // Watch saiyanTargets — queue new ones, remove departed
  useEffect(() => {
    const prev = prevSaiyanTargets.current;
    const newTargets = [...saiyanTargets].filter(t => !prev.has(t));

    if (newTargets.length > 0) {
      const wasEmpty = saiyanQueue.current.length === 0;
      saiyanQueue.current.push(...newTargets);
      // Start processing if queue was empty (otherwise already running)
      if (wasEmpty) processQueue();
    }

    // Remove cards for agents that lost Saiyan
    const removed = [...prev].filter(t => !saiyanTargets.has(t));
    if (removed.length > 0) {
      // Also remove from queue
      saiyanQueue.current = saiyanQueue.current.filter(t => !removed.includes(t));
      setSaiyanCards(prev => {
        const next = new Map(prev);
        for (const t of removed) {
          next.delete(t);
          clearTimeout(saiyanDismissTimers.current[t]);
        }
        return next;
      });
    }

    prevSaiyanTargets.current = new Set(saiyanTargets);
  }, [saiyanTargets, processQueue]);

  // Compute viewBox based on zoom and pan
  const vbW = 1200 / zoom;
  const vbH = 1000 / zoom;
  const vbX = (1200 - vbW) / 2 - pan.x;
  const vbY = (1000 - vbH) / 2 - pan.y;

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      style={{ background: "#020208", height: "calc(100vh - 60px)", cursor: isPanning ? "grabbing" : "default" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* SVG Mission Control */}
      <svg
        ref={svgRef}
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="mc-bg-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1a3e" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#020208" stopOpacity={0} />
          </radialGradient>
          <filter id="mc-glow">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
          </filter>
        </defs>

        {/* Background glow */}
        <circle cx={600} cy={500} r={500} fill="url(#mc-bg-glow)" />

        {/* Grid lines */}
        {Array.from({ length: 13 }, (_, i) => (
          <line key={`vl-${i}`} x1={i * 100} y1={0} x2={i * 100} y2={1000}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}
        {Array.from({ length: 11 }, (_, i) => (
          <line key={`hl-${i}`} x1={0} y1={i * 100} x2={1200} y2={i * 100}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}

        {/* Orbital rings */}
        <circle cx={600} cy={500} r={150} fill="none" stroke="#26c6da" strokeWidth={0.5} opacity={0.08}
          strokeDasharray="4 8" />
        <circle cx={600} cy={500} r={300} fill="none" stroke="#7e57c2" strokeWidth={0.5} opacity={0.06}
          strokeDasharray="6 12" />
        <circle cx={600} cy={500} r={450} fill="none" stroke="#ffa726" strokeWidth={0.5} opacity={0.04}
          strokeDasharray="8 16" />

        {/* Center hub */}
        <circle cx={600} cy={500} r={45} fill="none" stroke="#26c6da" strokeWidth={1} opacity={0.15} />
        <circle cx={600} cy={500} r={7} fill="#26c6da" opacity={0.4} />
        <text x={600} y={468} textAnchor="middle" fill="#26c6da" fontSize={12} opacity={0.5}
          fontFamily="'SF Mono', monospace" letterSpacing={5}>MISSION CONTROL</text>

        {/* Connection lines from hub to sessions */}
        {layout.map((s) => (
          <line key={`line-${s.session.name}`}
            x1={600} y1={500} x2={s.x} y2={s.y}
            stroke={s.style.accent} strokeWidth={0.5} opacity={0.08}
            strokeDasharray="2 6"
          />
        ))}

        {/* Session clusters */}
        {layout.map((s) => {
          const agentCount = s.agents.length;
          const clusterRadius = Math.max(70, 35 + agentCount * 18);
          const hasBusy = s.agents.some((a) => a.status === "busy");

          return (
            <g key={s.session.name}>
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
                        saiyan={saiyanTargets.has(agent.target)}
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
                    {isHovered && !hoverPreview && (
                      <g>
                        <rect x={-100} y={-65} width={200} height={34} rx={8}
                          fill="rgba(8,8,16,0.95)" stroke={s.style.accent} strokeWidth={0.8} opacity={0.95} />
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
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Controls — bottom right: pan + zoom in one cluster */}
      <div className="absolute bottom-4 right-6 flex flex-col items-center gap-1">
        <Joystick onPan={onJoystickPan} />
        <div className="w-6 border-t border-white/[0.06] my-0.5" />
        <button onClick={() => setZoom((z) => Math.min(3, z + 0.05))}
          className="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-lg font-bold cursor-pointer">+</button>
        <button onClick={resetView}
          className="w-8 h-6 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-[9px] text-white/50 hover:text-white hover:bg-white/10 cursor-pointer font-mono">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.05))}
          className="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-lg font-bold cursor-pointer">−</button>
      </div>

      {/* Saiyan toast notifications — top-right, small face + name like blockchain tx */}
      <div className="absolute top-3 right-3 z-50 flex flex-col gap-2 pointer-events-none" style={{ maxWidth: 220 }}>
        {[...saiyanCards.entries()].map(([target, card]) => {
          const color = agentColor(card.agent.name);
          const displayName = card.agent.name.replace(/-oracle$/, "").replace(/-/g, " ");
          return (
            <div
              key={`toast-${target}`}
              className="flex items-center gap-3 px-3 py-2 rounded-xl pointer-events-auto cursor-pointer"
              style={{
                background: "rgba(8,8,16,0.92)",
                border: `1px solid ${card.room.accent}40`,
                backdropFilter: "blur(12px)",
                boxShadow: `0 0 20px ${card.room.accent}15`,
                animation: "fadeSlideIn 0.25s ease-out",
              }}
              onClick={() => {
                // Click toast → pin that agent's card
                const pos = calcCardPos(card.svgX, card.svgY);
                setPinnedPreview({ agent: card.agent, room: card.room, pos, svgX: card.svgX, svgY: card.svgY });
                setHoverPreview(null);
                send({ type: "subscribe", target: card.agent.target });
                // Dismiss toast
                setSaiyanCards(prev => { const next = new Map(prev); next.delete(target); return next; });
              }}
            >
              {/* Mini chibi face */}
              <svg width={36} height={36} viewBox="-24 -34 48 68">
                <circle cx={0} cy={-10} r={20} fill={color} stroke="#fff" strokeWidth={2} />
                {/* Eyes */}
                <circle cx={-7} cy={-12} r={4.5} fill="#fff" />
                <circle cx={7} cy={-12} r={4.5} fill="#fff" />
                <circle cx={-6} cy={-12} r={2.5} fill="#222" />
                <circle cx={8} cy={-12} r={2.5} fill="#222" />
                <circle cx={-5} cy={-13.5} r={1} fill="#fff" />
                <circle cx={9} cy={-13.5} r={1} fill="#fff" />
                {/* Mouth */}
                <path d="M -3 -5 Q 0 -2 3 -5" fill="none" stroke="#333" strokeWidth={1.2} strokeLinecap="round" />
                {/* Hair */}
                <ellipse cx={-4} cy={-28} rx={6} ry={4} fill={color} stroke="#fff" strokeWidth={1} />
                <ellipse cx={4} cy={-29} rx={5} ry={3} fill={color} stroke="#fff" strokeWidth={1} />
                {/* Status dot */}
                <circle cx={16} cy={-28} r={4} fill="#fdd835" stroke="#1a1a1a" strokeWidth={1.5} />
              </svg>
              {/* Name + status */}
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold truncate" style={{ color: card.room.accent }}>
                  {displayName}
                </span>
                <span className="text-[10px] text-white/50 truncate">
                  {card.agent.preview?.slice(0, 30) || card.agent.status}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Hover Preview Card — manual hover (hidden when pinned) */}
      {hoverPreview && !pinnedPreview && (
        <div
          className="absolute z-30 pointer-events-auto"
          style={{
            left: hoverPreview.pos.x,
            top: hoverPreview.pos.y,
            maxWidth: 420,
            animation: "fadeSlideIn 0.15s ease-out",
          }}
          onMouseEnter={keepPreview}
          onMouseLeave={hidePreview}
        >
          <HoverPreviewCard
            agent={hoverPreview.agent}
            roomLabel={hoverPreview.room.label}
            accent={hoverPreview.room.accent}
          />
        </div>
      )}

      {/* Pinned Preview Card — slides from hover position to center */}
      {pinnedPreview && pinnedAnimPos && (
        <div
          ref={pinnedRef}
          className="absolute z-40 pointer-events-auto"
          style={{
            left: pinnedAnimPos.left,
            top: pinnedAnimPos.top,
            maxWidth: 420,
            transition: "left 0.3s ease-out, top 0.3s ease-out",
          }}
        >
          <HoverPreviewCard
            agent={pinnedPreview.agent}
            roomLabel={pinnedPreview.room.label}
            accent={pinnedPreview.room.accent}
            pinned
            send={send}
            onFullscreen={onPinnedFullscreen}
            onClose={onPinnedClose}
            eventLog={eventLog}
            addEvent={addEvent}
            externalInputBuf={getInputBuf(pinnedPreview.agent.target)}
            onInputBufChange={(val) => setInputBuf(pinnedPreview.agent.target, val)}
          />
        </div>
      )}

      {/* Search button — bottom left */}
      <button
        onClick={() => setShowSearch(true)}
        className="absolute bottom-4 left-6 flex items-center gap-2 px-3 py-2 rounded-xl bg-black/50 backdrop-blur border border-white/10 text-white/50 hover:text-[#64b5f6] hover:border-[#64b5f6]/30 cursor-pointer transition-all z-20"
        title="Search Oracle (⌘K)"
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx={11} cy={11} r={8} />
          <line x1={21} y1={21} x2={16.65} y2={16.65} />
        </svg>
        <span className="text-[10px] font-mono">Oracle</span>
        <kbd className="text-[8px] text-white/20 ml-1">⌘K</kbd>
      </button>

      {/* Oracle Search overlay — auto-shows when idle, dismissed until next activity */}
      {showSearch && <OracleSearch onClose={() => setShowSearch(false)} />}

      {/* Bottom stats */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-6 px-6 py-2 rounded-xl bg-black/40 backdrop-blur border border-white/[0.04]">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-yellow-400" />
          <strong className="text-yellow-400 text-xs">{busyCount}</strong>
          <span className="text-[10px] text-white/50">busy</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <strong className="text-emerald-400 text-xs">{readyCount}</strong>
          <span className="text-[10px] text-white/50">ready</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-white/30" />
          <strong className="text-white/50 text-xs">{idleCount}</strong>
          <span className="text-[10px] text-white/50">idle</span>
        </span>
        <div className="w-24 h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, (busyCount / Math.max(1, agents.length)) * 100)}%`,
              background: busyCount > 5 ? "#ef5350" : busyCount > 2 ? "#fdd835" : "#4caf50",
            }}
          />
        </div>
      </div>
    </div>
  );
});
