'use strict';
// How a newly docked card is announced on this computer.
const MODES = ['popup', 'banner', 'badge', 'off'];

// `announce` is the setting; older versions had a `dockPrompt` checkbox (false meant "just a notification").
function announceMode(settings) {
  if (MODES.includes(settings.announce)) return settings.announce;
  return settings.dockPrompt === false ? 'banner' : 'popup';
}

const soundOn = (settings) => settings.announceSound !== false;

// Dock badge / tray text for the cards still waiting for a decision.
function badgeText(count) { return count > 0 ? String(count) : ''; }

module.exports = { MODES, announceMode, soundOn, badgeText };
