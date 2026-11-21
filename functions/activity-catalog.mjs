import { validateCard, CATEGORIES } from './model.mjs';

const SCENES = [null, 'waiting', 'desk', 'outside', 'home'];
const ENERGIES = ['low', 'steady', 'high'];
const BUDGETS = [3, 5, 10, 15];
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value);
const subset = (values, allowed) => Array.isArray(values) && values.length > 0
  && new Set(values).size === values.length && values.every(value => allowed.includes(value));
const same = (left, right) => left === right || (left !== null && right !== null
  && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key])));
const sourcesValid = sources => Array.isArray(sources) && sources.length > 0 && sources.every(source => source
  && (source.kind === 'builtin' ? identifier(source.action) : source.kind === 'example' && /^[a-f0-9]{16}$/.test(source.id)));

export function reviewed(card) {
  const review = card.review;
  return review?.basis === 'existing_builtin'
    ? identifier(review.reference) && card.sources?.some(source => source.kind === 'builtin' && source.action === review.reference)
    : review?.basis === 'editor' && text(review.reviewer) && typeof review.reviewed_at === 'string'
      && Number.isFinite(Date.parse(review.reviewed_at));
}

export function eligibleCard(card, { scene = null, energy, budget }) {
  return card.status === 'published' && reviewed(card)
    && card.minutes >= 1 && card.minutes <= budget && card.scenes.includes(scene) && card.energies.includes(energy)
    && (energy !== 'low' || card.category !== 'explore')
    && card.requirements.items.length === 0 && card.requirements.stationary
    && card.requirements.interruptible && card.requirements.keeps_awareness;
}

export function coverageReport(catalog) {
  return SCENES.flatMap(scene => ENERGIES.flatMap(energy => BUDGETS.map(budget => {
    const cards = catalog.cards.filter(card => eligibleCard(card, { scene, energy, budget }));
    return { scene, energy, budget, cards: cards.length, prototypes: new Set(cards.map(card => card.prototype_id)).size };
  })));
}

export function validateCatalog(catalog, { requireCoverage = false, previous = null } = {}) {
  const errors = [];
  if (!catalog || !identifier(catalog.version) || !Array.isArray(catalog.prototypes)
    || !Array.isArray(catalog.cards) || !Array.isArray(catalog.history)) return ['INVALID_CATALOG'];
  const prototypes = new Map();
  for (const prototype of catalog.prototypes) {
    if (!prototype || !identifier(prototype.id) || prototypes.has(prototype.id)
      || !CATEGORIES.includes(prototype.category) || !text(prototype.core_action)
      || !text(prototype.variation) || !text(prototype.completion) || !sourcesValid(prototype.sources)) {
      errors.push('INVALID_PROTOTYPE');
      continue;
    }
    prototypes.set(prototype.id, prototype);
  }
  const cards = new Map();
  for (const card of catalog.cards) {
    if (!card || !identifier(card.id) || cards.has(card.id) || !identifier(card.content_version)
      || !prototypes.has(card.prototype_id) || prototypes.get(card.prototype_id)?.category !== card.category
      || !['draft', 'published', 'retired'].includes(card.status)
      || !subset(card.scenes, SCENES) || !subset(card.energies, ENERGIES)
      || !card.energies.every(energy => validateCard(card, 15, energy)) || !sourcesValid(card.sources)
      || !card.requirements || !Array.isArray(card.requirements.items)
      || !card.requirements.items.every(text)
      || ['stationary', 'interruptible', 'keeps_awareness'].some(key => typeof card.requirements[key] !== 'boolean')
      || (card.status === 'published' && (!reviewed(card) || card.requirements.items.length > 0
        || !card.requirements.stationary || !card.requirements.interruptible || !card.requirements.keeps_awareness))) {
      errors.push('INVALID_CARD');
      continue;
    }
    cards.set(card.id, card);
  }
  const history = new Map();
  for (const entry of catalog.history) {
    if (!entry || !identifier(entry.id) || history.has(entry.id) || !prototypes.has(entry.prototype_id)
      || !text(entry.title) || (cards.has(entry.id) && cards.get(entry.id).prototype_id !== entry.prototype_id)) {
      errors.push('INVALID_HISTORY');
      continue;
    }
    history.set(entry.id, entry);
  }
  if (previous) {
    if (catalog.version === previous.version) errors.push('VERSION_NOT_CHANGED');
    for (const old of previous.cards) {
      const current = cards.get(old.id);
      // Published identifiers are immutable; retiring keeps their full historical content.
      if (!current || !same({ ...current, status: old.status }, old)
        || (old.status !== current.status && current.status !== 'retired')) errors.push('CARD_VERSION_CHANGED');
    }
    for (const old of previous.prototypes) {
      const current = prototypes.get(old.id);
      if (!current || current.category !== old.category || current.core_action !== old.core_action) errors.push('PROTOTYPE_CHANGED');
    }
    for (const old of previous.history) {
      if (!same(history.get(old.id), old)) errors.push('HISTORY_CHANGED');
    }
  }
  if (requireCoverage && !errors.length && coverageReport(catalog).some(row => row.prototypes < 2)) errors.push('INSUFFICIENT_COVERAGE');
  return errors;
}
