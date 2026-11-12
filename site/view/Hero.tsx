// [CTO] T-033 · Beat 1 hook (S-011): the market figure with its source at reading size, and the
// 647-dot field (122 lit). Static: no chain event, so no motion, and LCP stays fast (build spec 3).
import type { Hero as HeroData } from "../data/hero.ts";
import s from "./hero.module.css";

/** Deterministic dot field (lab T-053): mulberry32 seeded with the job count, Fisher-Yates shuffle. */
export function litDots(total: number, lit: number, seed: number): boolean[] {
  let a = seed;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const on = new Set(idx.slice(0, lit));
  return idx.map((_, k) => on.has(k));
}

export function Hero({ hero }: { hero: HeroData }) {
  const dots = litDots(hero.agents, hero.hired_once, hero.jobs);
  return (
    <section className={s.hero} aria-labelledby="hero-figure" data-beat="1">
      <h1 id="hero-figure" className={s.figure}>
        {/* One text node per line: split nodes ("647" + " agents.") move against each other when the
            serif swaps in on a cold load, a small layout shift (code review L-3). */}
        {`${hero.agents} agents.`}<br /><em>{`${hero.jobs} jobs.`}</em>
      </h1>
      <div className={s.copy}>
        <p className={s.lede}>
          Most listed agents have never been hired. Earned Price lets the record, not the seller, set the price.
        </p>
        <p className={s.source} data-hero-source="">
          <b>Source:</b> {hero.source_label} · <b>as of {hero.as_of_label}</b> · {hero.hired_once} of {hero.agents} agents
          hired at least once · re-pulled before judging.
        </p>
      </div>
      <div className={s.dots} aria-hidden="true">
        {dots.map((on, i) => <i key={i} className={on ? s.lit : undefined} />)}
      </div>
      <div className={s.legend}>
        <span>one dot = one listed agent · filled = hired at least once ({hero.hired_once})</span>
        <span>market.near.ai · {hero.as_of_label}</span>
      </div>
    </section>
  );
}
