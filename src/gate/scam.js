// Scam Shield: spots the patterns behind most voice-driven money scams
// (grandparent scams, fake officials, gift-card and crypto demands).
// Deterministic phrase matching on purpose: an attacker cannot argue with it.

const SIGNALS = [
  { id: 'urgency', weight: 20, label: 'urgent pressure to act now', patterns: [/\burgent(ly)?\b/i, /\bright now\b/i, /\bimmediately\b/i, /\bas soon as possible\b/i, /\bbefore it'?s too late\b/i] },
  { id: 'secrecy', weight: 30, label: 'being told to keep it secret', patterns: [/\bdon'?t tell\b/i, /\bkeep (it|this) (a )?secret\b/i, /\bbetween us\b/i, /\bnobody (can|should) know\b/i] },
  { id: 'emergency_story', weight: 25, label: 'an emergency story (bail, hospital, arrest)', patterns: [/\bbail\b/i, /\bjail\b/i, /\barrest(ed)?\b/i, /\bhospital\b/i, /\baccident\b/i, /\bstranded\b/i] },
  { id: 'authority', weight: 25, label: 'someone claiming to be an official (IRS, police, bank)', patterns: [/\birs\b/i, /\btax (office|department)\b/i, /\bpolice\b/i, /\bsheriff\b/i, /\bfraud department\b/i, /\bsocial security\b/i] },
  { id: 'untraceable_payment', weight: 30, label: 'a request for gift cards, crypto or wire', patterns: [/\bgift ?cards?\b/i, /\bbitcoin\b/i, /\bcrypto\b/i, /\bwire (it|the money|transfer)\b/i] },
  { id: 'prize', weight: 20, label: 'a prize or lottery that needs a fee', patterns: [/\blottery\b/i, /\byou'?ve won\b/i, /\bprize\b/i, /\bprocessing fee\b/i] },
  { id: 'remote_instruction', weight: 15, label: 'someone on the phone telling you what to say', patterns: [/\bhe said to\b/i, /\bshe said to\b/i, /\bthey told me to\b/i, /\bon the phone\b/i, /\bthe caller\b/i] },
];

export function scanForScam(utterance = '') {
  const hits = [];
  for (const s of SIGNALS) {
    if (s.patterns.some((p) => p.test(utterance))) hits.push({ id: s.id, weight: s.weight, label: s.label });
  }
  const score = Math.min(100, hits.reduce((sum, h) => sum + h.weight, 0));
  return { score, hits };
}
