const DIVISION_STYLE: Record<string, { color: string; icon: string }> = {
  Bronze: { color: '#cd7f32', icon: '🥉' },
  Silver: { color: '#b8bfc9', icon: '🥈' },
  Gold: { color: '#f1c40f', icon: '🥇' },
  Platinum: { color: '#7fdbe0', icon: '🔷' },
  Diamond: { color: '#7fb6ff', icon: '💎' },
  Master: { color: '#c792ea', icon: '👑' },
};

export default function DivisionBadge({ division, compact = false }: { division: string; compact?: boolean }) {
  const style = DIVISION_STYLE[division] ?? DIVISION_STYLE.Bronze;
  return (
    <span
      style={{
        color: style.color,
        fontWeight: 700,
        fontSize: compact ? '0.75rem' : '0.85rem',
        whiteSpace: 'nowrap',
      }}
      title={`${division} division`}
    >
      {style.icon} {compact ? '' : division}
    </span>
  );
}
