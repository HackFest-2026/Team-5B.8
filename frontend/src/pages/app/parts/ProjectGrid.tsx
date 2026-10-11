import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useDropdown } from '@/hooks/useDropdown';
import type { Project } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { dateOnly, plural } from '@/lib/format';
import s from './ProjectGrid.module.css';

/**
 * The project cards, and the screen an empty account sees instead of them.
 *
 * Both live here rather than on a page of their own: the account dashboard owns
 * the only place either one is shown, and splitting them across two routes was
 * two screens answering one question.
 *
 * No numbers on the cards, on purpose. A card's job is recognition and entry —
 * which system is this, is it running, how do I get in — and a grid of mixed
 * metrics from unrelated businesses is noise that makes that job harder. The
 * numbers are one tap away, in the project that owns them.
 */
export function ProjectGrid({
  projects,
  onOpen,
  onDelete,
}: {
  projects: Project[];
  onOpen: (p: Project) => void;
  onDelete: (p: Project) => void;
}) {
  const navigate = useNavigate();

  return (
    <section className={s.section}>
      <div className={s.head}>
        <h2 className={s.title}>Your pricing systems</h2>
        <span className={s.sub}>Open one to manage its products, rules and limits</span>
      </div>

      <div className={s.grid}>
        {projects.map((p) => {
          const draft = p.mode === 'draft';
          const on = p.mode === 'active';
          return (
            <div key={p.project_id} className={s.cardWrap}>
            <CardMenu onDelete={() => onDelete(p)} />
            <button
              type="button"
              className={cx(s.card, draft && s.cardDraft, on && s.cardOn)}
              onClick={() => onOpen(p)}
            >
              <span className={s.cardGlow} aria-hidden="true" />

              <span className={s.cardTop}>
                <span className={s.mark} aria-hidden="true">
                  <Icon name={markFor(p.domain_name)} size={18} />
                </span>
                <span className={cx(s.state, on && s.stateOn, draft && s.stateDraft)}>
                  {on && <span className={s.stateDot} />}
                  {draft ? 'In setup' : on ? 'On' : 'Off'}
                </span>
              </span>

              <span className={s.cardBody}>
                <span className={s.name}>{p.name}</span>
                <span className={s.meta}>
                  {p.domain_name} · {plural(p.item_count, p.entity_label.toLowerCase())}
                </span>
              </span>

              {draft && (
                <span className={s.bar}>
                  <span className={s.barFill} style={{ width: p.item_count > 0 ? '55%' : '25%' }} />
                </span>
              )}

              <span className={s.cardFoot}>
                <span>{draft ? 'Setup not finished' : `Since ${dateOnly(p.created_at)}`}</span>
                <span className={s.go}>
                  {draft ? 'Continue' : 'Open'}
                  <Icon name="arrow-right" size={13} />
                </span>
              </span>
            </button>
            </div>
          );
        })}

        {/* The way in sits in the grid rather than floating over it, so adding a
            system reads as one more card instead of a button covering content. */}
        <button type="button" className={s.addCard} onClick={() => navigate('/app/projects/new')}>
          <span className={s.addIcon}>
            <Icon name="plus" size={20} strokeWidth={2.2} />
          </span>
          <span className={s.addText}>Create a pricing system</span>
          <span className={s.addSub}>Takes about two minutes</span>
        </button>
      </div>
    </section>
  );
}

/**
 * The three-dots menu on a card. It sits OUTSIDE the card button (the card is
 * itself a button, so a nested one would be invalid) and above it, so the kebab
 * and the menu never trigger "open the project".
 */
function CardMenu({ onDelete }: { onDelete: () => void }) {
  const dd = useDropdown<HTMLDivElement>();
  return (
    <div className={s.menu} ref={dd.containerRef}>
      <button
        type="button"
        ref={dd.triggerRef}
        className={s.kebab}
        aria-label="Project options"
        aria-haspopup="menu"
        aria-expanded={dd.open}
        onClick={dd.toggle}
      >
        <span className={s.kebabDots}>⋮</span>
      </button>
      {dd.open && (
        <div className={s.menuPop} role="menu">
          <button
            type="button"
            role="menuitem"
            className={s.menuItemDanger}
            onClick={() => {
              dd.close();
              onDelete();
            }}
          >
            <Icon name="close" size={14} />
            Delete project
          </button>
        </div>
      )}
    </div>
  );
}

/* ── empty ───────────────────────────────────────────────────────────── */

/**
 * The first screen of an empty account.
 *
 * A dashed box saying "nothing here" tells a new user what they already know.
 * This instead shows the thing they are about to build: a request arriving, the
 * engine deciding, a price going back — which is the entire product in one
 * picture, and the reason to press the button underneath it.
 */
export function EmptyAccount() {
  const navigate = useNavigate();
  return (
    <div className={s.empty}>
      <div className={s.emptyArt}>
        <EngineDiagram />
      </div>

      <div className={s.emptyCopy}>
        <h1 className={s.emptyTitle}>Price anything, in real time</h1>
        <p className={s.emptyBody}>
          A pricing system holds what you sell, the rules that move the price, and the limits it
          must never cross. Your app asks for a price; DevNexus answers in milliseconds and can
          always explain why.
        </p>

        <ul className={s.steps}>
          <Step icon="projects" title="Describe what you sell" body="Rooms, rides, SKUs — anything." />
          <Step icon="rules" title="Write the rules in plain terms" body="When demand is high, add 10%." />
          <Step icon="shield" title="Set the limits it cannot cross" body="Floors, ceilings, margins." />
        </ul>

        <button type="button" className={s.emptyCta} onClick={() => navigate('/app/projects/new')}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
          Create your first pricing system
        </button>
      </div>
    </div>
  );
}

function Step({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <li className={s.step}>
      <span className={s.stepIcon}>
        <Icon name={icon} size={15} />
      </span>
      <span>
        <span className={s.stepTitle}>{title}</span>
        <span className={s.stepBody}>{body}</span>
      </span>
    </li>
  );
}

/**
 * Request in, decision, price out — drawn rather than described.
 *
 * Pure SVG and CSS: the dashes travel along the connecting paths, so the
 * picture reads as flow without a single frame of JavaScript. It resolves to a
 * still diagram when the viewer prefers reduced motion.
 */
function EngineDiagram() {
  return (
    <svg viewBox="0 0 260 200" className={s.svg} role="img" aria-label="A request becoming a price">
      <defs>
        <linearGradient id="emCore" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.06" />
        </linearGradient>
      </defs>

      {/* Inputs are labelled, because an unlabelled box is a shape and a
          labelled one is an explanation. These are the three things every
          domain has some version of. */}
      {[
        { y: 48, label: 'demand' },
        { y: 100, label: 'stock' },
        { y: 152, label: 'time' },
      ].map(({ y, label }, i) => (
        <g key={y}>
          <rect
            x="4" y={y - 13} width="62" height="26" rx="7"
            className={s.node} style={{ animationDelay: `${i * 0.18}s` }}
          />
          <text x="35" y={y + 4} className={s.nodeText} textAnchor="middle">
            {label}
          </text>
          <path
            d={`M 66 ${y} C 92 ${y}, 96 100, 112 100`}
            className={s.wire} style={{ animationDelay: `${i * 0.3}s` }}
          />
        </g>
      ))}

      {/* the engine */}
      <rect x="112" y="68" width="64" height="64" rx="16" fill="url(#emCore)" className={s.core} />
      <rect x="112" y="68" width="64" height="64" rx="16" className={s.coreEdge} />
      <g className={s.gear}>
        <circle cx="144" cy="100" r="12" className={s.coreRing} />
        <circle cx="144" cy="100" r="4" className={s.coreDot} />
      </g>

      {/* output */}
      <path d="M 176 100 C 196 100, 198 100, 212 100" className={s.wireOut} />
      <rect x="206" y="82" width="46" height="36" rx="9" className={s.price} />
      <text x="229" y="105" className={s.priceText} textAnchor="middle">₹</text>
      <text x="229" y="134" className={s.caption} textAnchor="middle">your price</text>
      <text x="144" y="152" className={s.caption} textAnchor="middle">the engine</text>
    </svg>
  );
}

/** A recognisable glyph per industry, falling back to a neutral one. */
function markFor(domain: string): IconName {
  const d = (domain || '').toLowerCase();
  if (d.includes('commerce') || d.includes('retail')) return 'projects';
  if (d.includes('hospital') || d.includes('hotel')) return 'overview';
  if (d.includes('transport') || d.includes('ride') || d.includes('logistic')) return 'live';
  if (d.includes('travel') || d.includes('flight')) return 'analytics';
  if (d.includes('energy') || d.includes('charg')) return 'sparkle';
  if (d.includes('rental') || d.includes('lease')) return 'decisions';
  return 'projects';
}
