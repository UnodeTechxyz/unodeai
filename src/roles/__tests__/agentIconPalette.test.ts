import { describe, expect, it } from 'vitest';
import { AGENT_ICON_PALETTE, FALLBACK_AGENT_ICON, distinctAgentIcon, iconForSavedAgent } from '../agentIconPalette';

describe('AGENT_ICON_PALETTE', () => {
  it('offers at least 50 glyphs and repeats none of them', () => {
    expect(AGENT_ICON_PALETTE.length).toBeGreaterThanOrEqual(50);
    expect(new Set(AGENT_ICON_PALETTE).size).toBe(AGENT_ICON_PALETTE.length);
  });

  it('contains no empty or whitespace entries', () => {
    for (const icon of AGENT_ICON_PALETTE) {
      expect(icon.trim(), JSON.stringify(icon)).toBe(icon);
      expect(icon.length).toBeGreaterThan(0);
    }
  });
});

describe('distinctAgentIcon', () => {
  it('keeps the role template preference when nobody else wears it', () => {
    expect(distinctAgentIcon('🧪', ['📋', '💻'])).toBe('🧪');
  });

  it('moves off a preference the roster already uses', () => {
    // Three role templates legitimately prefer the clipboard; the second and third must not get it.
    const first = distinctAgentIcon('📋', []);
    const second = distinctAgentIcon('📋', [first]);
    const third = distinctAgentIcon('📋', [first, second]);
    expect(first).toBe('📋');
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('ignores empty and undefined entries in what is taken', () => {
    expect(distinctAgentIcon('🧭', [undefined, '', '  ' as string])).toBe('🧭');
  });

  it('gives a whole roster distinct icons even when every role prefers the same one', () => {
    const assigned: string[] = [];
    for (let i = 0; i < AGENT_ICON_PALETTE.length; i++) {
      assigned.push(distinctAgentIcon('📋', assigned));
    }
    expect(new Set(assigned).size).toBe(AGENT_ICON_PALETTE.length);
  });

  it('allows a repeat rather than failing once the palette is exhausted', () => {
    // A roster larger than the palette is not a reason to refuse to create an agent.
    const everything = [...AGENT_ICON_PALETTE];
    expect(distinctAgentIcon('📋', everything)).toBe('📋');
    expect(distinctAgentIcon(undefined, everything)).toBe(FALLBACK_AGENT_ICON);
  });

  it('falls back to the palette when a custom uploaded icon is not offered', () => {
    // A data: URI is a legitimate preference and is kept; it just cannot be deduplicated against.
    const custom = 'data:image/png;base64,AAAA';
    expect(distinctAgentIcon(custom, ['📋'])).toBe(custom);
    expect(distinctAgentIcon(custom, [custom])).toBe(AGENT_ICON_PALETTE[0]);
  });
});

describe('iconForSavedAgent', () => {
  const taken = ['📋', '💻'];

  it('deduplicates a role default that the panel filled in, not the user', () => {
    // The regression this exists for: the Agent Builder writes the role's icon into the field on every
    // role switch, so a submitted value is NOT evidence of a choice. Without the flag this returned 📋.
    const icon = iconForSavedAgent({ submitted: '📋', explicit: false, templateIcon: '📋', isEdit: false, taken });
    expect(icon).not.toBe('📋');
    expect(AGENT_ICON_PALETTE).toContain(icon);
  });

  it('honours an icon the user actually picked, duplicate or not', () => {
    expect(iconForSavedAgent({ submitted: '📋', explicit: true, templateIcon: '📋', isEdit: false, taken })).toBe('📋');
  });

  it('never re-picks while editing an existing agent', () => {
    // Its icon is how the user finds its row; an unrelated edit must not move that landmark.
    expect(iconForSavedAgent({ submitted: '📋', explicit: false, templateIcon: '📋', isEdit: true, taken })).toBe('📋');
  });

  it('falls back to the role default when the field is empty', () => {
    expect(iconForSavedAgent({ submitted: '', explicit: false, templateIcon: '🧪', isEdit: true, taken })).toBe('🧪');
    expect(iconForSavedAgent({ submitted: '', explicit: false, templateIcon: '📋', isEdit: false, taken })).not.toBe('📋');
  });

  it('keeps a free role default rather than reshuffling for no reason', () => {
    expect(iconForSavedAgent({ submitted: '🧪', explicit: false, templateIcon: '🧪', isEdit: false, taken })).toBe('🧪');
  });
});
