import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { audio } from './audio';
import { getSocket } from './socket';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BattlePlayerStat {
  id: string;
  name: string;
  alive: boolean;
  badges: number;
  kos: number;
}

export type TargetMode = 'random' | 'attacker' | 'badges' | 'kos';

export interface KOEvent {
  uid: string;
  deadName: string;
  killerName: string | null;
  badgesTransferred: number;
  time: number;
}

// ── Badge tier ────────────────────────────────────────────────────────────────

export function getBadgeTier(badges: number): { color: string; mult: string; label: string; tier: number } {
  if (badges >= 12) return { color: '#ff4400', mult: '×2.0', label: '◆◆◆◆', tier: 4 };
  if (badges >= 6)  return { color: '#ff9900', mult: '×1.75', label: '◆◆◆',  tier: 3 };
  if (badges >= 3)  return { color: '#ffdd00', mult: '×1.5',  label: '◆◆',   tier: 2 };
  if (badges >= 1)  return { color: '#00f0f0', mult: '×1.25', label: '◆',    tier: 1 };
  return { color: 'rgba(255,255,255,0.28)', mult: '×1.0', label: '—', tier: 0 };
}

// ── Mini Board (SVG) ─────────────────────────────────────────────────────────

const BCOLS = 10, BROWS = 20;

function MiniBoard({ board, cs, alive, isTarget, isAttacker }: {
  board: (string | 0)[][] | undefined;
  cs: number; alive: boolean;
  isTarget: boolean; isAttacker: boolean;
}) {
  const W = BCOLS * cs, H = BROWS * cs;
  const borderColor = isTarget ? '#ff4400' : isAttacker ? '#ff0088' : 'rgba(0,240,240,0.14)';
  const bw = (isTarget || isAttacker) ? 2 : 1;
  const shadow = isTarget
    ? '0 0 10px #ff440099, 0 0 3px #ff4400'
    : isAttacker ? '0 0 8px #ff008888' : 'none';

  return (
    <svg width={W} height={H} style={{
      display: 'block', background: '#000a18',
      border: `${bw}px solid ${borderColor}`,
      boxShadow: shadow, opacity: alive ? 1 : 0.3,
      transition: 'border-color 0.18s, box-shadow 0.18s',
    }}>
      {board && Array.from({ length: BROWS }, (_, r) =>
        Array.from({ length: BCOLS }, (_, c) => {
          const cell = board[r]?.[c];
          return cell ? (
            <rect key={`${r}-${c}`}
              x={c * cs + 0.5} y={r * cs + 0.5}
              width={cs - 1} height={cs - 1}
              fill={cell as string} opacity={0.88}
            />
          ) : null;
        })
      )}
      {!alive && (
        <>
          <rect width={W} height={H} fill="rgba(0,0,0,0.55)" />
          <line x1="6" y1="6" x2={W - 6} y2={H - 6} stroke="rgba(255,40,40,0.65)" strokeWidth="1.5" />
          <line x1={W - 6} y1="6" x2="6" y2={H - 6} stroke="rgba(255,40,40,0.65)" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

// ── Player Card ───────────────────────────────────────────────────────────────

function PlayerCard({ stat, board, cs, isTarget, isAttacker, targeterCount, onClick }: {
  stat: BattlePlayerStat; board: (string | 0)[][] | undefined;
  cs: number; isTarget: boolean; isAttacker: boolean;
  targeterCount: number; onClick: () => void;
}) {
  const { color: badgeColor } = getBadgeTier(stat.badges);
  const nameColor = isTarget ? '#ff4400' : isAttacker ? '#ff0088' : 'rgba(255,255,255,0.55)';
  const W = BCOLS * cs;

  return (
    <div onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      cursor: stat.alive ? 'pointer' : 'default',
      userSelect: 'none', position: 'relative',
    }}>
      {isTarget && (
        <div style={{
          position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)',
          color: '#ff4400', fontSize: 9, fontFamily: '"Orbitron",monospace',
          fontWeight: 900, textShadow: '0 0 8px #ff4400', lineHeight: 1,
          animation: 'battleTargetPulse 0.55s ease-in-out infinite', zIndex: 2,
        }}>▼</div>
      )}

      <MiniBoard board={board} cs={cs} alive={stat.alive} isTarget={isTarget} isAttacker={isAttacker} />

      <div style={{
        fontSize: Math.max(6, cs), fontFamily: '"Orbitron",monospace',
        color: nameColor, letterSpacing: '0.04em',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: W, textShadow: isTarget ? '0 0 6px #ff4400' : 'none',
        transition: 'color 0.15s',
      }}>{stat.name}</div>

      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {stat.badges > 0 && (
          <span style={{ fontSize: Math.max(6, cs - 1), color: badgeColor, fontFamily: '"Orbitron",monospace', textShadow: `0 0 4px ${badgeColor}66` }}>
            ◆{stat.badges}
          </span>
        )}
        {stat.kos > 0 && (
          <span style={{ fontSize: Math.max(6, cs - 1), color: '#ff6600', fontFamily: '"Orbitron",monospace' }}>
            ⚡{stat.kos}
          </span>
        )}
        {targeterCount > 0 && (
          <span style={{ fontSize: Math.max(5, cs - 2), color: '#ff0088', fontFamily: '"Orbitron",monospace' }}>
            🎯{targeterCount}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Incoming Garbage Bar (T99-style segment meter) ───────────────────────────

const GARBAGE_BAR_MAX = 20; // one segment per board row

// T99 flash timing: orange warning (0.5s), red danger (0.18s)
const BAR_ANIM_CSS = `
  @keyframes barFlashWarn {
    0%,100% { opacity:1; }
    50%     { opacity:0.35; }
  }
  @keyframes barFlashDanger {
    0%,100% { opacity:1; box-shadow: 0 0 8px #ff220099; }
    50%     { opacity:0.25; box-shadow: 0 0 4px #ff220044; }
  }
`;

export function IncomingBar({ pending, height }: { pending: number; height?: number | string }) {
  const segments = Math.min(pending, GARBAGE_BAR_MAX);
  // T99-accurate color tiers
  const danger = pending >= 8;
  const warn   = pending >= 4;
  const color  = danger ? '#ff2200' : warn ? '#ff8800' : '#ffdd00';
  const anim   = danger ? 'barFlashDanger 0.18s ease-in-out infinite'
               : warn   ? 'barFlashWarn 0.5s ease-in-out infinite'
               : 'none';
  const glow   = danger ? `0 0 10px ${color}aa` : warn ? `0 0 6px ${color}77` : 'none';

  return (
    <>
      <style>{BAR_ANIM_CSS}</style>
      <div style={{
        width: 10,
        height: height ?? '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 1,
        flexShrink: 0,
        padding: '1px 0',
        boxSizing: 'border-box',
      }}>
        {Array.from({ length: GARBAGE_BAR_MAX }, (_, i) => {
          const idx = GARBAGE_BAR_MAX - 1 - i; // 0=bottom, MAX-1=top
          const filled = idx < segments;
          return (
            <div key={i} style={{
              width: '100%',
              flex: 1,
              borderRadius: 2,
              background: filled ? color : 'rgba(255,255,255,0.05)',
              boxShadow: filled ? glow : 'none',
              transition: 'background 0.08s',
              animation: filled ? anim : 'none',
            }} />
          );
        })}
      </div>
    </>
  );
}

// ── Target Mode Button ────────────────────────────────────────────────────────

const TARGET_MODES: { mode: TargetMode; icon: string; label: string; desc: string; color: string }[] = [
  { mode: 'random',   icon: '?',  label: 'RANDOM',   desc: 'ランダムに狙う',     color: '#00f0f0' },
  { mode: 'attacker', icon: '↩',  label: 'ATTACKER', desc: '攻撃してきた相手',  color: '#ff4400' },
  { mode: 'badges',   icon: '◆',  label: 'BADGES',   desc: 'バッジ最多の相手',  color: '#ffcc00' },
  { mode: 'kos',      icon: '⚡',  label: 'KOs',      desc: 'KO最多の相手',     color: '#aa00ff' },
];

function TargetModeBtn({ mode, onCycle, showKeyHint }: { mode: TargetMode; onCycle: () => void; showKeyHint?: boolean }) {
  const info = TARGET_MODES.find(m => m.mode === mode) ?? TARGET_MODES[0];
  return (
    <button onClick={onCycle} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '5px 8px',
      background: `${info.color}14`,
      border: `1.5px solid ${info.color}66`,
      borderRadius: 6, cursor: 'pointer', outline: 'none',
      transition: 'all 0.12s', userSelect: 'none', width: '100%',
    }} title={showKeyHint ? `[Tab] ${info.desc}` : info.desc}>
      <div style={{
        fontSize: 13, color: info.color,
        textShadow: `0 0 10px ${info.color}`,
        lineHeight: 1, fontFamily: '"Orbitron",monospace',
      }}>{info.icon}</div>
      <div style={{
        fontSize: 7, color: info.color,
        fontFamily: '"Orbitron",monospace', fontWeight: 700,
        letterSpacing: '0.18em',
      }}>{info.label}</div>
      <div style={{
        fontSize: 6, color: `${info.color}88`,
        fontFamily: '"Orbitron",monospace',
        letterSpacing: '0.08em', textAlign: 'center',
      }}>{info.desc}</div>
      {showKeyHint && (
        <div style={{
          marginTop: 2, padding: '1px 5px',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 3, fontSize: 6,
          color: 'rgba(255,255,255,0.45)',
          fontFamily: '"Orbitron",monospace', letterSpacing: '0.12em',
        }}>TAB</div>
      )}
    </button>
  );
}

// ── KO Feed ──────────────────────────────────────────────────────────────────

export function KOFeed({ events }: { events: KOEvent[] }) {
  const now = Date.now();
  const visible = events.filter(e => now - e.time < 3500).slice(-5);
  if (visible.length === 0) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column-reverse', gap: 4,
      zIndex: 8500, pointerEvents: 'none', alignItems: 'center',
    }}>
      {visible.map((e, i) => {
        const age = now - e.time;
        const op = Math.max(0, 1 - age / 3500) * (1 - i * 0.18);
        return (
          <div key={e.uid} style={{
            padding: '3px 10px', background: 'rgba(0,0,0,0.88)',
            border: '1px solid rgba(255,100,0,0.35)', borderRadius: 20,
            display: 'flex', gap: 6, alignItems: 'center', opacity: op,
            transition: 'opacity 0.3s',
          }}>
            {e.killerName && (
              <span style={{ fontFamily: '"Orbitron",monospace', fontSize: 8, color: '#ff6600', fontWeight: 700, letterSpacing: '0.1em' }}>
                {e.killerName}
              </span>
            )}
            <span style={{ fontFamily: '"Orbitron",monospace', fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>⚡ KO</span>
            <span style={{ fontFamily: '"Orbitron",monospace', fontSize: 8, color: '#ff2828', fontWeight: 700 }}>
              {e.deadName}
            </span>
            {e.badgesTransferred > 0 && (
              <span style={{ fontFamily: '"Orbitron",monospace', fontSize: 7, color: '#ffcc00' }}>
                +◆{e.badgesTransferred + 1}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Battle Stats Panel ────────────────────────────────────────────────────────

export function BattleStatsPanel({ myStats, targetMode, currentTarget, targetedByCount, aliveCount, totalCount, onCycleMode, showKeyHints }: {
  myStats: BattlePlayerStat | undefined;
  targetMode: TargetMode;
  currentTarget: BattlePlayerStat | null;
  targetedByCount: number;
  aliveCount: number;
  totalCount: number;
  onCycleMode: () => void;
  showKeyHints?: boolean;
}) {
  const tier = getBadgeTier(myStats?.badges ?? 0);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '8px 6px',
      background: 'linear-gradient(160deg,#04101e,#000810)',
      border: '1px solid rgba(0,240,240,0.1)',
      borderRadius: 8, fontFamily: '"Orbitron",monospace',
      minWidth: 96,
    }}>
      {/* Remaining players */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 6, borderBottom: '1px solid rgba(0,240,240,0.07)' }}>
        <div style={{ fontSize: 6, letterSpacing: '0.3em', color: 'rgba(0,240,240,0.4)', marginBottom: 2 }}>REMAINING</div>
        <div style={{
          fontSize: 38, fontWeight: 900, lineHeight: 1,
          color: aliveCount <= 3 ? '#ff4400' : '#00f0f0',
          textShadow: aliveCount <= 3 ? '0 0 20px #ff4400' : '0 0 16px #00f0f0cc',
        }}>{aliveCount}</div>
        <div style={{ fontSize: 7, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em' }}>/ {totalCount}</div>
      </div>

      {/* My badges */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 6, borderBottom: '1px solid rgba(0,240,240,0.07)' }}>
        <div style={{ fontSize: 6, letterSpacing: '0.3em', color: 'rgba(0,240,240,0.35)', marginBottom: 1 }}>BADGES</div>
        <div style={{
          fontSize: 18, fontWeight: 900, lineHeight: 1,
          color: tier.color, textShadow: `0 0 12px ${tier.color}aa`,
        }}>◆{myStats?.badges ?? 0}</div>
        <div style={{ fontSize: 6, color: tier.color, opacity: 0.75 }}>{tier.mult}</div>
      </div>

      {/* KOs */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 6, borderBottom: '1px solid rgba(0,240,240,0.07)' }}>
        <div style={{ fontSize: 6, letterSpacing: '0.3em', color: 'rgba(255,100,0,0.4)', marginBottom: 1 }}>KOs</div>
        <div style={{
          fontSize: 18, fontWeight: 900, lineHeight: 1,
          color: '#ff6600', textShadow: '0 0 10px #ff660077',
        }}>⚡{myStats?.kos ?? 0}</div>
      </div>

      {/* Targeted by */}
      {targetedByCount > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingBottom: 6, borderBottom: '1px solid rgba(0,240,240,0.07)',
          animation: 'battleTargetPulse 0.8s ease-in-out infinite',
        }}>
          <div style={{ fontSize: 6, letterSpacing: '0.2em', color: 'rgba(255,0,136,0.5)', marginBottom: 1 }}>TARGETED</div>
          <div style={{ fontSize: 13, fontWeight: 900, color: '#ff0088', textShadow: '0 0 10px #ff008877' }}>
            🎯×{targetedByCount}
          </div>
        </div>
      )}

      {/* Mode button */}
      <TargetModeBtn mode={targetMode} onCycle={onCycleMode} showKeyHint={showKeyHints} />

      {/* Current target */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ fontSize: 6, letterSpacing: '0.2em', color: 'rgba(255,100,0,0.4)', marginBottom: 1 }}>TARGET</div>
        <div style={{
          fontSize: 7, fontWeight: 700,
          color: currentTarget ? '#ff4400' : 'rgba(255,255,255,0.25)',
          textShadow: currentTarget ? '0 0 6px #ff4400' : 'none',
          letterSpacing: '0.08em', textAlign: 'center',
          maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{currentTarget ? currentTarget.name : '—'}</div>
      </div>
    </div>
  );
}

// ── Mini Board Grid (exported as function returning split left/right JSX) ─────

export function T99BoardGrid({ myId, playerStats, otherBoards, playerTargets, currentTargetId, onClickPlayer, maxPanelWidth = 200 }: {
  myId: string;
  playerStats: BattlePlayerStat[];
  otherBoards: Record<string, (string | 0)[][]>;
  playerTargets: Record<string, string>;
  currentTargetId: string | null;
  onClickPlayer: (id: string) => void;
  maxPanelWidth?: number;
}): { left: React.ReactNode; right: React.ReactNode } | null {
  const others = playerStats.filter(p => p.id !== myId);
  if (others.length === 0) return null;

  const N = others.length;
  // Adaptive cell size: fit 2 columns of mini boards within maxPanelWidth
  // Panel = 2 * (BCOLS * cs + 4) + gap(8) → cs = (maxPanelWidth - 16) / (2 * BCOLS)
  const maxCsByWidth = Math.max(3, Math.floor((maxPanelWidth - 16) / (2 * BCOLS)));
  const naturalCs = N <= 2 ? 8 : N <= 4 ? 7 : N <= 8 ? 6 : N <= 14 ? 5 : 4;
  const cs = Math.min(naturalCs, maxCsByWidth);

  // Who is targeting me
  const targetersOfMe = new Set(
    Object.entries(playerTargets)
      .filter(([pid, tid]) => tid === myId && pid !== myId)
      .map(([pid]) => pid)
  );

  // How many targeting each player
  const targetCounts: Record<string, number> = {};
  for (const tid of Object.values(playerTargets)) {
    targetCounts[tid] = (targetCounts[tid] ?? 0) + 1;
  }

  const half = Math.ceil(others.length / 2);
  const left = others.slice(0, half);
  const right = others.slice(half);

  const colStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(2, ${BCOLS * cs + 4}px)`,
    gap: 8,
    alignContent: 'start',
  };

  const renderCards = (players: BattlePlayerStat[]) =>
    players.map(stat => (
      <PlayerCard
        key={stat.id}
        stat={stat}
        board={otherBoards[stat.id]}
        cs={cs}
        isTarget={stat.id === currentTargetId}
        isAttacker={targetersOfMe.has(stat.id)}
        targeterCount={targetCounts[stat.id] ?? 0}
        onClick={() => onClickPlayer(stat.id)}
      />
    ));

  return {
    left: <div style={colStyle}>{renderCards(left)}</div>,
    right: <div style={colStyle}>{renderCards(right)}</div>,
  };
}

// ── Flash Overlays ────────────────────────────────────────────────────────────

export function BattleEffects({ attackFlash, incomingFlash, myKOFlash }: {
  attackFlash: number;
  incomingFlash: boolean;
  myKOFlash: KOEvent | null;
}) {
  return (
    <>
      <style>{`
        @keyframes battleTargetPulse {
          0%,100% { opacity:1; transform:translateX(-50%) scale(1); }
          50%      { opacity:0.45; transform:translateX(-50%) scale(1.25); }
        }
        @keyframes battleAttackPop {
          0%   { opacity:0; transform:scale(0.5) translateY(14px); }
          16%  { opacity:1; transform:scale(1.08) translateY(0); }
          60%  { opacity:1; transform:scale(1); }
          100% { opacity:0; transform:scale(0.9) translateY(-18px); }
        }
        @keyframes battleIncomingPop {
          0%   { opacity:0; transform:scale(0.55); }
          14%  { opacity:1; transform:scale(1.1); }
          55%  { opacity:1; transform:scale(1); }
          100% { opacity:0; transform:scale(0.88); }
        }
        @keyframes battleKOPop {
          0%   { opacity:0; transform:scale(0.35) rotate(-6deg); }
          12%  { opacity:1; transform:scale(1.18) rotate(3deg); }
          28%  { transform:scale(1) rotate(0deg); }
          68%  { opacity:1; }
          100% { opacity:0; transform:scale(1.1) translateY(-24px); }
        }
        @keyframes battleGlowBg {
          0%   { opacity:0; }
          18%  { opacity:1; }
          68%  { opacity:0.55; }
          100% { opacity:0; }
        }
        @keyframes battleBarFlash {
          0%,100% { opacity:1; }
          50%     { opacity:0.45; }
        }
        @keyframes boardShake {
          0%,100% { transform:translateX(0); }
          14%     { transform:translateX(-7px); }
          28%     { transform:translateX(7px); }
          42%     { transform:translateX(-5px); }
          57%     { transform:translateX(5px); }
          72%     { transform:translateX(-3px); }
          86%     { transform:translateX(3px); }
        }
      `}</style>

      {/* Attack flash */}
      {attackFlash > 0 && (
        <div key={`atk-${attackFlash}`} style={{
          position: 'fixed', inset: 0, zIndex: 9200, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            animation: 'battleAttackPop 0.7s ease-out forwards',
            fontFamily: '"Orbitron",monospace', fontWeight: 900,
            fontSize: 'clamp(22px,5vw,54px)', color: '#00ff88',
            textShadow: '0 0 32px #00ff88, 0 0 64px #00ff4455',
            letterSpacing: '0.1em', whiteSpace: 'nowrap',
          }}>⚡ ATTACK!</div>
          <div style={{
            position: 'fixed', inset: 0, pointerEvents: 'none',
            animation: 'battleGlowBg 0.7s ease-out forwards',
            background: 'radial-gradient(ellipse at center, rgba(0,255,136,0.14) 0%, transparent 65%)',
          }} />
        </div>
      )}

      {/* Incoming flash */}
      {incomingFlash && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9200, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            animation: 'battleIncomingPop 0.65s ease-out forwards',
            fontFamily: '"Orbitron",monospace', fontWeight: 900,
            fontSize: 'clamp(18px,4.5vw,50px)', color: '#ff2828',
            textShadow: '0 0 32px #ff2828, 0 0 64px #ff000044',
            letterSpacing: '0.08em', whiteSpace: 'nowrap',
          }}>☠ INCOMING!</div>
          <div style={{
            position: 'fixed', inset: 0, pointerEvents: 'none',
            animation: 'battleGlowBg 0.65s ease-out forwards',
            background: 'radial-gradient(ellipse at center, rgba(255,40,40,0.16) 0%, transparent 65%)',
          }} />
        </div>
      )}

      {/* KO flash (when YOU get a KO) */}
      {myKOFlash && (
        <div key={myKOFlash.uid} style={{
          position: 'fixed', inset: 0, zIndex: 9300, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <div style={{
            animation: 'battleKOPop 0.9s ease-out forwards',
            fontFamily: '"Orbitron",monospace', fontWeight: 900,
            fontSize: 'clamp(36px,9vw,90px)', color: '#ff4400',
            textShadow: '0 0 40px #ff4400, 0 0 80px #ff440044',
            letterSpacing: '0.15em',
          }}>KO!</div>
          {myKOFlash.badgesTransferred > 0 && (
            <div style={{
              animation: 'battleKOPop 0.9s ease-out 0.12s forwards',
              fontFamily: '"Orbitron",monospace', fontWeight: 900, opacity: 0,
              fontSize: 'clamp(14px,3vw,28px)', color: '#ffcc00',
              textShadow: '0 0 20px #ffcc00aa', letterSpacing: '0.12em',
            }}>+◆{myKOFlash.badgesTransferred + 1} BADGE{myKOFlash.badgesTransferred > 0 ? 'S' : ''}</div>
          )}
          <div style={{
            position: 'fixed', inset: 0, pointerEvents: 'none',
            animation: 'battleGlowBg 0.9s ease-out forwards',
            background: 'radial-gradient(ellipse at center, rgba(255,68,0,0.2) 0%, transparent 60%)',
          }} />
        </div>
      )}
    </>
  );
}

// ── Mobile Battle HUD ─────────────────────────────────────────────────────────

export function MobileBattleHUD({ myStats, targetMode, currentTarget, targetedByCount, aliveCount, totalCount, pendingGarbage, onCycleMode }: {
  myStats: BattlePlayerStat | undefined;
  targetMode: TargetMode;
  currentTarget: BattlePlayerStat | null;
  targetedByCount: number;
  aliveCount: number;
  totalCount: number;
  pendingGarbage: number;
  onCycleMode: () => void;
}) {
  const tier = getBadgeTier(myStats?.badges ?? 0);
  const modeInfo = TARGET_MODES.find(m => m.mode === targetMode)!;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px',
      background: 'rgba(0,4,16,0.9)',
      borderBottom: '1px solid rgba(0,240,240,0.1)',
      fontFamily: '"Orbitron",monospace',
      flexWrap: 'wrap',
    }}>
      {/* Remaining — large display */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 44 }}>
        <div style={{ fontSize: 5, color: 'rgba(0,240,240,0.5)', letterSpacing: '0.2em' }}>LEFT</div>
        <div style={{
          fontSize: 26, fontWeight: 900, lineHeight: 1,
          color: aliveCount <= 3 ? '#ff4400' : '#00f0f0',
          textShadow: aliveCount <= 3 ? '0 0 14px #ff4400' : '0 0 10px #00f0f0aa',
        }}>{aliveCount}</div>
        <div style={{ fontSize: 5, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em' }}>/{totalCount}</div>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 32 }}>
        <div style={{ fontSize: 5, color: 'rgba(0,240,240,0.4)', letterSpacing: '0.2em' }}>BADGE</div>
        <div style={{ fontSize: 16, fontWeight: 900, lineHeight: 1, color: tier.color, textShadow: `0 0 8px ${tier.color}88` }}>
          ◆{myStats?.badges ?? 0}
        </div>
      </div>

      {/* KOs */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }}>
        <div style={{ fontSize: 5, color: 'rgba(255,100,0,0.4)', letterSpacing: '0.2em' }}>KO</div>
        <div style={{ fontSize: 16, fontWeight: 900, lineHeight: 1, color: '#ff6600' }}>
          ⚡{myStats?.kos ?? 0}
        </div>
      </div>

      {/* Targeted by */}
      {targetedByCount > 0 && (
        <div style={{
          fontSize: 10, color: '#ff0088', fontWeight: 700,
          animation: 'battleTargetPulse 0.8s ease-in-out infinite',
          textShadow: '0 0 8px #ff008888',
        }}>🎯×{targetedByCount}</div>
      )}

      {/* Target mode button — bigger, clearer */}
      <button onClick={onCycleMode} style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
        padding: '5px 10px',
        background: `${modeInfo.color}18`,
        border: `1.5px solid ${modeInfo.color}66`,
        borderRadius: 6, cursor: 'pointer', outline: 'none',
        marginLeft: 'auto',
      }}>
        <span style={{ fontSize: 12, color: modeInfo.color, fontFamily: '"Orbitron",monospace', fontWeight: 900, textShadow: `0 0 8px ${modeInfo.color}` }}>
          {modeInfo.icon} {modeInfo.label}
        </span>
        {currentTarget && (
          <span style={{ fontSize: 8, color: '#ff4400', fontFamily: '"Orbitron",monospace', fontWeight: 700, letterSpacing: '0.08em' }}>
            ▶ {currentTarget.name}
          </span>
        )}
        {!currentTarget && (
          <span style={{ fontSize: 7, color: `${modeInfo.color}88`, fontFamily: '"Orbitron",monospace' }}>
            {modeInfo.desc}
          </span>
        )}
      </button>

      {/* Incoming garbage indicator */}
      {pendingGarbage > 0 && (
        <div style={{
          fontSize: 10, color: pendingGarbage >= 6 ? '#ff0000' : '#ff8800',
          fontFamily: '"Orbitron",monospace', fontWeight: 700,
          textShadow: `0 0 8px ${pendingGarbage >= 6 ? '#ff0000' : '#ff8800'}88`,
          animation: pendingGarbage >= 6 ? 'battleBarFlash 0.4s ease-in-out infinite' : 'none',
        }}>▼{pendingGarbage}</div>
      )}
    </div>
  );
}

// ── useBattleScreen hook ──────────────────────────────────────────────────────

export function useBattleScreen(myId: string) {
  const [playerStats, setPlayerStats] = useState<BattlePlayerStat[]>([]);
  const [otherBoards, setOtherBoards] = useState<Record<string, (string | 0)[][]>>({});
  const [playerTargets, setPlayerTargets] = useState<Record<string, string>>({});
  const [pendingGarbage, setPendingGarbage] = useState(0);
  const [targetMode, setTargetMode] = useState<TargetMode>('random');
  const [manualTargetId, setManualTargetId] = useState<string | null>(null);
  const [lastAttackerId, setLastAttackerId] = useState<string | null>(null);
  const [koFeed, setKOFeed] = useState<KOEvent[]>([]);
  const [attackFlash, setAttackFlash] = useState(0);
  const [incomingFlash, setIncomingFlash] = useState(false);
  const [myKOFlash, setMyKOFlash] = useState<KOEvent | null>(null);
  const [shakeKey, setShakeKey] = useState(0);

  const playerStatsRef = useRef(playerStats);
  playerStatsRef.current = playerStats;
  const pendingGarbageRef = useRef(pendingGarbage);
  pendingGarbageRef.current = pendingGarbage;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  const manualTargetIdRef = useRef(manualTargetId);
  manualTargetIdRef.current = manualTargetId;
  const lastAttackerIdRef = useRef(lastAttackerId);
  lastAttackerIdRef.current = lastAttackerId;
  const targetModeRef = useRef(targetMode);
  targetModeRef.current = targetMode;

  // Clear manual target if it dies or mode changes
  useEffect(() => { setManualTargetId(null); }, [targetMode]);
  useEffect(() => {
    if (manualTargetId) {
      const t = playerStats.find(p => p.id === manualTargetId);
      if (!t || !t.alive) setManualTargetId(null);
    }
  }, [playerStats, manualTargetId]);

  // Compute current target ID
  const currentTargetId = (() => {
    const alive = playerStatsRef.current.filter(p => p.alive && p.id !== myId);
    if (alive.length === 0) return null;

    // Manual override takes priority
    if (manualTargetId) {
      const t = alive.find(p => p.id === manualTargetId);
      if (t) return manualTargetId;
    }

    switch (targetMode) {
      case 'attacker': {
        const atk = alive.find(p => p.id === lastAttackerId);
        if (atk) return atk.id;
        return alive[Math.floor(Math.random() * alive.length)]?.id ?? null;
      }
      case 'badges': {
        const sorted = [...alive].sort((a, b) => b.badges - a.badges);
        return sorted[0]?.id ?? null;
      }
      case 'kos': {
        const sorted = [...alive].sort((a, b) => b.kos - a.kos);
        return sorted[0]?.id ?? null;
      }
      default: return null; // random: picked fresh at send time
    }
  })();

  const currentTargetIdRef = useRef(currentTargetId);
  currentTargetIdRef.current = currentTargetId;

  // Notify server when target changes
  useEffect(() => {
    if (!myId) return;
    try { getSocket().emit('set_target', { targetId: currentTargetId ?? null }); } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTargetId, myId]);

  // Socket subscriptions — register regardless of myId so events are never missed
  useEffect(() => {
    const sock = getSocket();

    const onStatsUpdate = (data: { players: BattlePlayerStat[] }) => {
      const prevStats = playerStatsRef.current;
      setPlayerStats(data.players);
      // Detect badge gain (compare to previous)
      const myPrev = prevStats.find(p => p.id === myIdRef.current);
      const myNew  = data.players.find(p => p.id === myIdRef.current);
      if (myNew && myPrev && myNew.badges > myPrev.badges) {
        audio.playBadgeEarn();
      }
    };

    const onTargetsUpdate = (data: { targets: Record<string, string> }) => {
      setPlayerTargets(data.targets);
    };

    const onPlayerBoard = ({ playerId, board }: { playerId: string; board: (string | 0)[][] }) => {
      console.log('[GhostBoards] player_board received from', playerId, 'board rows:', board?.length);
      setOtherBoards(prev => ({ ...prev, [playerId]: board }));
    };

    const onReceiveGarbage = ({ lines, fromId }: { lines: number; fromId: string; fromName: string; fromBadges: number }) => {
      setPendingGarbage(g => g + lines);
      setLastAttackerId(fromId);
      lastAttackerIdRef.current = fromId;
      audio.playGarbageReceive();
      setIncomingFlash(true);
      setShakeKey(k => k + 1);
      setTimeout(() => setIncomingFlash(false), 750);
    };

    const onPlayerDied = (data: {
      playerId: string; deadName: string;
      killerId: string | null; killerName: string | null;
      badgesTransferred: number;
    }) => {
      const ev: KOEvent = {
        uid: `ko-${Date.now()}-${Math.random()}`,
        deadName: data.deadName,
        killerName: data.killerName,
        badgesTransferred: data.badgesTransferred,
        time: Date.now(),
      };
      setKOFeed(prev => [...prev.slice(-12), ev]);
      if (data.killerId === myIdRef.current) {
        audio.playKO();
        setMyKOFlash(ev);
        setTimeout(() => setMyKOFlash(null), 950);
      }
      setOtherBoards(prev => {
        const n = { ...prev };
        delete n[data.playerId];
        return n;
      });
    };

    const onGameEnded = () => {
      setOtherBoards({});
      setPlayerTargets({});
    };

    sock.on('stats_update', onStatsUpdate);
    sock.on('targets_update', onTargetsUpdate);
    sock.on('player_board', onPlayerBoard);
    sock.on('receive_garbage', onReceiveGarbage);
    sock.on('player_died', onPlayerDied);
    sock.on('game_ended', onGameEnded);

    return () => {
      sock.off('stats_update', onStatsUpdate);
      sock.off('targets_update', onTargetsUpdate);
      sock.off('player_board', onPlayerBoard);
      sock.off('receive_garbage', onReceiveGarbage);
      sock.off('player_died', onPlayerDied);
      sock.off('game_ended', onGameEnded);
    };
  }, [myId]);

  // Purge stale KO feed entries
  useEffect(() => {
    const iv = setInterval(() => {
      const cutoff = Date.now() - 4000;
      setKOFeed(prev => prev.filter(e => e.time > cutoff));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const resetBattleState = useCallback(() => {
    setPlayerStats([]);
    setOtherBoards({});
    setPlayerTargets({});
    setPendingGarbage(0);
    setKOFeed([]);
    setAttackFlash(0);
    setIncomingFlash(false);
    setMyKOFlash(null);
    setLastAttackerId(null);
    setManualTargetId(null);
  }, []);

  const cycleTargetMode = useCallback(() => {
    const idx = TARGET_MODES.findIndex(m => m.mode === targetModeRef.current);
    const next = TARGET_MODES[(idx + 1) % TARGET_MODES.length];
    setTargetMode(next.mode);
    audio.playTargetChange();
  }, []);

  const setManualTarget = useCallback((id: string) => {
    setManualTargetId(id);
  }, []);

  const sendGarbage = useCallback((baseLines: number, myBadges: number) => {
    if (baseLines <= 0) return;
    const mult = myBadges >= 11 ? 2.0 : myBadges >= 6 ? 1.75 : myBadges >= 3 ? 1.5 : myBadges >= 1 ? 1.25 : 1.0;
    const finalLines = Math.max(1, Math.round(baseLines * mult));

    const stats = playerStatsRef.current;
    const alive = stats.filter(p => p.alive && p.id !== myIdRef.current);
    if (alive.length === 0) return;

    let tid = currentTargetIdRef.current;
    if (!tid || !stats.find(p => p.id === tid && p.alive)) {
      tid = alive[Math.floor(Math.random() * alive.length)]?.id ?? null;
    }
    if (!tid) return;

    try {
      getSocket().emit('send_garbage', { lines: finalLines, targetId: tid });
      setAttackFlash(f => f + 1);
    } catch (_) {}
  }, []);

  const consumePendingGarbage = useCallback((): number => {
    const amt = pendingGarbageRef.current;
    if (amt > 0) setPendingGarbage(0);
    return amt;
  }, []);

  // Cancel up to `amount` lines from the pending queue and return how many
  // were actually cancelled (may be less if pending < amount).
  const cancelPendingGarbage = useCallback((amount: number): number => {
    const cancelled = Math.min(pendingGarbageRef.current, amount);
    if (cancelled > 0) setPendingGarbage(g => Math.max(0, g - cancelled));
    return cancelled;
  }, []);

  return {
    playerStats, otherBoards, playerTargets,
    pendingGarbage, pendingGarbageRef, targetMode, currentTargetId,
    koFeed, attackFlash, incomingFlash, myKOFlash, shakeKey,
    cycleTargetMode, setManualTarget, sendGarbage,
    consumePendingGarbage, cancelPendingGarbage, resetBattleState,
  };
}
