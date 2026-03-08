import { useState, useRef, useCallback, useEffect, memo } from "react";

interface JoystickProps {
  onPan: (dx: number, dy: number) => void;
}

const RADIUS = 28;
const KNOB_R = 10;

export const Joystick = memo(function Joystick({ onPan }: JoystickProps) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const center = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number>(0);
  const knobRef = useRef({ x: 0, y: 0 });
  const baseRef = useRef<SVGCircleElement>(null);

  const clamp = (x: number, y: number) => {
    const d = Math.sqrt(x * x + y * y);
    if (d <= RADIUS) return { x, y };
    return { x: (x / d) * RADIUS, y: (y / d) * RADIUS };
  };

  // Continuous pan loop while dragging
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      const { x, y } = knobRef.current;
      if (x !== 0 || y !== 0) {
        onPan(x * 0.15, y * 0.15);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(frameRef.current); };
  }, [onPan]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragging.current = true;
    const rect = baseRef.current?.getBoundingClientRect();
    if (rect) {
      center.current = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - center.current.x;
    const dy = e.clientY - center.current.y;
    const pos = clamp(dx, dy);
    setKnob(pos);
    knobRef.current = pos;
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    setKnob({ x: 0, y: 0 });
    knobRef.current = { x: 0, y: 0 };
  }, []);

  return (
    <svg
      width={76}
      height={76}
      viewBox="-38 -38 76 76"
      className="cursor-grab active:cursor-grabbing"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Base ring */}
      <circle ref={baseRef} cx={0} cy={0} r={RADIUS} fill="rgba(255,255,255,0.03)"
        stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      {/* Cross guides */}
      <line x1={0} y1={-RADIUS + 4} x2={0} y2={RADIUS - 4} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
      <line x1={-RADIUS + 4} y1={0} x2={RADIUS - 4} y2={0} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
      {/* Knob */}
      <circle
        cx={knob.x}
        cy={knob.y}
        r={KNOB_R}
        fill="rgba(38,198,218,0.25)"
        stroke="rgba(38,198,218,0.5)"
        strokeWidth={1.5}
        style={{ transition: dragging.current ? "none" : "cx 0.2s, cy 0.2s" }}
      />
      <circle cx={knob.x} cy={knob.y} r={3} fill="rgba(38,198,218,0.6)" />
    </svg>
  );
});
